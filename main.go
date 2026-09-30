package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

const (
	cookieName      = "barcode_session"
	sessionDuration = 12 * time.Hour
	maxUploadSize   = 10 << 20 // 10 MiB
)

//go:embed templates/*.html static/*
var content embed.FS

type App struct {
	db        *sql.DB
	templates *template.Template
}

type User struct {
	ID    int64
	Name  string
	Login string
	Role  string
}

type sessionUser struct {
	User
	CSRF string
}

type contextKey string

const userContextKey contextKey = "user"

func main() {
	addr := getenv("APP_ADDR", ":8080")
	dbPath := getenv("APP_DB", "./data/inventory.db")

	if err := os.MkdirAll(filepath.Dir(dbPath), 0o750); err != nil {
		log.Fatal(err)
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	// SQLite works best for this workload with WAL enabled and a busy timeout.
	if _, err := db.Exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`); err != nil {
		log.Fatal(err)
	}

	if err := migrate(db); err != nil {
		log.Fatal(err)
	}

	if err := bootstrapUsers(db, getenv("BOOTSTRAP_USERS_CSV", "./users.csv")); err != nil {
		log.Fatal(err)
	}

	tmpl := template.Must(template.ParseFS(content, "templates/*.html"))
	app := &App{db: db, templates: tmpl}

	staticFS, err := fs.Sub(content, "static")
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))))
	mux.HandleFunc("GET /healthz", app.health)
	mux.HandleFunc("GET /login", app.loginPage)
	mux.HandleFunc("POST /login", app.login)
	mux.Handle("POST /logout", app.requireAuth(app.requireCSRF(http.HandlerFunc(app.logout))))

	mux.Handle("GET /", app.requireAuth(http.HandlerFunc(app.home)))
	mux.Handle("GET /scan", app.requireAuth(http.HandlerFunc(app.scanPage)))
	mux.Handle("POST /api/scan", app.requireAuth(app.requireCSRF(http.HandlerFunc(app.scanAPI))))

	mux.Handle("GET /admin", app.requireAdmin(http.HandlerFunc(app.adminPage)))
	mux.Handle("POST /admin/users/add", app.requireAdmin(app.requireCSRF(http.HandlerFunc(app.addUser))))
	mux.Handle("POST /admin/users/delete", app.requireAdmin(app.requireCSRF(http.HandlerFunc(app.deleteUser))))
	mux.Handle("POST /admin/items/upload", app.requireAdmin(app.requireCSRF(http.HandlerFunc(app.uploadItems))))
	mux.Handle("POST /admin/items/delete", app.requireAdmin(app.requireCSRF(http.HandlerFunc(app.deleteItems))))
	mux.Handle("POST /admin/items/clear-scans", app.requireAdmin(app.requireCSRF(http.HandlerFunc(app.clearScans))))

	handler := securityHeaders(logRequests(mux))
	server := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	log.Printf("barcode app listening on %s", addr)
	log.Fatal(server.ListenAndServe())
}

func migrate(db *sql.DB) error {
	_, err := db.Exec(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    login TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','user')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barcode TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    scanned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
`)
	return err
}

// bootstrapUsers imports a CSV only when the users table is empty.
// CSV columns: name,login,password,role
func bootstrapUsers(db *sql.DB, path string) error {
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("no users exist; create %s using users.csv.example", path)
	}
	if err != nil {
		return err
	}
	defer f.Close()

	r := csv.NewReader(f)
	records, err := r.ReadAll()
	if err != nil {
		return fmt.Errorf("read bootstrap users CSV: %w", err)
	}
	if len(records) < 2 {
		return errors.New("bootstrap users CSV has no user rows")
	}

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	adminCount := 0
	for i, row := range records[1:] {
		if len(row) < 4 {
			return fmt.Errorf("users.csv row %d must contain name,login,password,role", i+2)
		}
		name := strings.TrimSpace(row[0])
		login := strings.TrimSpace(row[1])
		password := row[2]
		role := strings.ToLower(strings.TrimSpace(row[3]))
		if name == "" || login == "" || len(password) < 8 || (role != "admin" && role != "user") {
			return fmt.Errorf("invalid users.csv row %d", i+2)
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO users(name,login,password_hash,role) VALUES(?,?,?,?)`, name, login, string(hash), role); err != nil {
			return fmt.Errorf("insert bootstrap user %q: %w", login, err)
		}
		if role == "admin" {
			adminCount++
		}
	}
	if adminCount == 0 {
		return errors.New("users.csv must include at least one admin")
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	log.Printf("imported %d bootstrap user(s) from %s; plaintext passwords are now hashed in SQLite", len(records)-1, path)
	return nil
}

func (a *App) loginPage(w http.ResponseWriter, r *http.Request) {
	if _, err := a.currentUser(r); err == nil {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	a.render(w, "login.html", map[string]any{"Error": r.URL.Query().Get("error")})
}

func (a *App) login(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}
	login := strings.TrimSpace(r.FormValue("login"))
	password := r.FormValue("password")

	var u User
	var hash string
	err := a.db.QueryRow(`SELECT id,name,login,role,password_hash FROM users WHERE login = ?`, login).
		Scan(&u.ID, &u.Name, &u.Login, &u.Role, &hash)
	if err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		http.Redirect(w, r, "/login?error=Invalid+credentials", http.StatusSeeOther)
		return
	}

	rawToken, err := randomToken(32)
	if err != nil {
		http.Error(w, "session error", http.StatusInternalServerError)
		return
	}
	csrf, err := randomToken(24)
	if err != nil {
		http.Error(w, "session error", http.StatusInternalServerError)
		return
	}
	expires := time.Now().Add(sessionDuration)
	_, err = a.db.Exec(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES(?,?,?,?)`, tokenHash(rawToken), u.ID, csrf, expires.Unix())
	if err != nil {
		http.Error(w, "session error", http.StatusInternalServerError)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    rawToken,
		Path:     "/",
		Expires:  expires,
		MaxAge:   int(sessionDuration.Seconds()),
		HttpOnly: true,
		Secure:   isSecureRequest(r),
		SameSite: http.SameSiteStrictMode,
	})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(cookieName); err == nil {
		_, _ = a.db.Exec(`DELETE FROM sessions WHERE token_hash = ?`, tokenHash(c.Value))
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: isSecureRequest(r)})
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

func (a *App) home(w http.ResponseWriter, r *http.Request) {
	u := mustUser(r)
	if u.Role == "admin" {
		http.Redirect(w, r, "/admin", http.StatusSeeOther)
		return
	}
	http.Redirect(w, r, "/scan", http.StatusSeeOther)
}

func (a *App) scanPage(w http.ResponseWriter, r *http.Request) {
	u := mustUser(r)
	a.render(w, "scan.html", map[string]any{"User": u})
}

func (a *App) scanAPI(w http.ResponseWriter, r *http.Request) {
	u := mustUser(r)
	var in struct {
		Barcode string `json:"barcode"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": "Invalid request"})
		return
	}
	barcode := normalizeBarcode(in.Barcode)
	if barcode == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": "Empty barcode"})
		return
	}

	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSON(w, 500, map[string]any{"status": "error", "message": "Database error"})
		return
	}
	defer tx.Rollback()

	var itemID int64
	var name string
	err = tx.QueryRow(`SELECT id,name FROM items WHERE barcode = ?`, barcode).Scan(&itemID, &name)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]any{"status": "not_found", "barcode": barcode, "message": "Barcode is not in the item list"})
		return
	}
	if err != nil {
		writeJSON(w, 500, map[string]any{"status": "error", "message": "Database error"})
		return
	}

	var scannedBy, scannedAt string
	err = tx.QueryRow(`
SELECT users.name, scans.scanned_at
FROM scans JOIN users ON users.id = scans.user_id
WHERE scans.item_id = ?`, itemID).Scan(&scannedBy, &scannedAt)
	if err == nil {
		writeJSON(w, http.StatusConflict, map[string]any{
			"status": "duplicate", "barcode": barcode, "item": name,
			"message": fmt.Sprintf("Already scanned by %s at %s", scannedBy, scannedAt),
		})
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, 500, map[string]any{"status": "error", "message": "Database error"})
		return
	}

	_, err = tx.Exec(`INSERT INTO scans(item_id,user_id) VALUES(?,?)`, itemID, u.ID)
	if err != nil {
		// UNIQUE(item_id) is the final duplicate-scan guard if two users scan simultaneously.
		writeJSON(w, http.StatusConflict, map[string]any{"status": "duplicate", "barcode": barcode, "item": name, "message": "Item was already scanned"})
		return
	}
	if err := tx.Commit(); err != nil {
		writeJSON(w, 500, map[string]any{"status": "error", "message": "Database error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "success", "barcode": barcode, "item": name, "message": "Item marked successfully"})
}

type ItemRow struct {
	ID            int64
	Barcode       string
	Name          string
	Category      string
	CategoryLower string
	ScannedBy     string
	ScannedAt     string
}

func (a *App) adminPage(w http.ResponseWriter, r *http.Request) {
	u := mustUser(r)
	users, err := a.listUsers(r.Context())
	if err != nil {
		http.Error(w, "database error", 500)
		return
	}
	var itemCount, scanCount int
	_ = a.db.QueryRow(`SELECT COUNT(*) FROM items`).Scan(&itemCount)
	_ = a.db.QueryRow(`SELECT COUNT(*) FROM scans`).Scan(&scanCount)

	// Fetch items with scan info
	rows, err := a.db.QueryContext(r.Context(), `
		SELECT i.id, i.barcode, i.name,
		       COALESCE(u.name,'') as scanned_by,
		       COALESCE(s.scanned_at,'') as scanned_at
		FROM items i
		LEFT JOIN scans s ON s.item_id = i.id
		LEFT JOIN users u ON u.id = s.user_id
		ORDER BY i.name`)
	var items []ItemRow
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var it ItemRow
			if err := rows.Scan(&it.ID, &it.Barcode, &it.Name, &it.ScannedBy, &it.ScannedAt); err == nil {
				// Derive category from name e.g. "Disc Dhol Dandiya - A001" or barcode prefix
				cat := ""
				if len(it.Name) > 0 {
					// look for " - X" pattern at end of name
					for i := len(it.Name) - 1; i >= 0; i-- {
						if it.Name[i] == '-' && i+2 < len(it.Name) {
							cat = string(it.Name[i+2])
							break
						}
					}
				}
				if cat == "" && len(it.Barcode) > 0 {
					cat = string(it.Barcode[0])
				}
				it.Category = strings.ToUpper(cat)
				it.CategoryLower = strings.ToLower(cat)
				items = append(items, it)
			}
		}
	}

	a.render(w, "admin.html", map[string]any{
		"User": u, "Users": users, "ItemCount": itemCount, "ScanCount": scanCount,
		"Items":   items,
		"Message": r.URL.Query().Get("message"), "Error": r.URL.Query().Get("error"),
	})
}

func (a *App) listUsers(ctx context.Context) ([]User, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT id,name,login,role FROM users ORDER BY role,name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Name, &u.Login, &u.Role); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (a *App) addUser(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		adminError(w, r, "Invalid form")
		return
	}
	name := strings.TrimSpace(r.FormValue("name"))
	login := strings.TrimSpace(r.FormValue("login"))
	password := r.FormValue("password")
	role := strings.ToLower(strings.TrimSpace(r.FormValue("role")))
	if name == "" || login == "" || len(password) < 8 || (role != "admin" && role != "user") {
		adminError(w, r, "Name/login required, password must be at least 8 characters, and role must be admin or user")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		adminError(w, r, "Could not hash password")
		return
	}
	if _, err := a.db.Exec(`INSERT INTO users(name,login,password_hash,role) VALUES(?,?,?,?)`, name, login, string(hash), role); err != nil {
		adminError(w, r, "Login already exists or data is invalid")
		return
	}
	adminMessage(w, r, "User added")
}

func (a *App) deleteUser(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		adminError(w, r, "Invalid form")
		return
	}
	current := mustUser(r)
	id, err := strconv.ParseInt(r.FormValue("id"), 10, 64)
	if err != nil || id <= 0 {
		adminError(w, r, "Invalid user")
		return
	}
	if id == current.ID {
		adminError(w, r, "You cannot delete your own account")
		return
	}

	var role string
	if err := a.db.QueryRow(`SELECT role FROM users WHERE id=?`, id).Scan(&role); err != nil {
		adminError(w, r, "User not found")
		return
	}
	if role == "admin" {
		var admins int
		_ = a.db.QueryRow(`SELECT COUNT(*) FROM users WHERE role='admin'`).Scan(&admins)
		if admins <= 1 {
			adminError(w, r, "Cannot delete the last admin")
			return
		}
	}
	if _, err := a.db.Exec(`DELETE FROM users WHERE id=?`, id); err != nil {
		adminError(w, r, "Could not delete user")
		return
	}
	adminMessage(w, r, "User removed")
}

func (a *App) uploadItems(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)
	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		adminError(w, r, "CSV is too large or invalid")
		return
	}
	file, _, err := r.FormFile("items_csv")
	if err != nil {
		adminError(w, r, "Choose a CSV file")
		return
	}
	defer file.Close()

	items, err := parseItemsCSV(file)
	if err != nil {
		adminError(w, r, err.Error())
		return
	}

	tx, err := a.db.Begin()
	if err != nil {
		adminError(w, r, "Database error")
		return
	}
	defer tx.Rollback()

	// Add only — never delete existing items or scans
	stmt, err := tx.Prepare(`INSERT OR IGNORE INTO items(barcode,name,description) VALUES(?,?,?)`)
	if err != nil {
		adminError(w, r, "Database error")
		return
	}
	defer stmt.Close()

	added, skipped := 0, 0
	for _, it := range items {
		res, err := stmt.Exec(it.Barcode, it.Name, it.Description)
		if err != nil {
			adminError(w, r, "Database error on barcode: "+it.Barcode)
			return
		}
		rows, _ := res.RowsAffected()
		if rows == 0 {
			skipped++
		} else {
			added++
		}
	}
	if err := tx.Commit(); err != nil {
		adminError(w, r, "Could not save item list")
		return
	}
	adminMessage(w, r, fmt.Sprintf("Added %d items, skipped %d duplicates", added, skipped))
}

type itemCSV struct {
	Barcode     string
	Name        string
	Description string
}

func parseItemsCSV(file multipart.File) ([]itemCSV, error) {
	r := csv.NewReader(file)
	r.TrimLeadingSpace = true
	header, err := r.Read()
	if err != nil {
		return nil, errors.New("could not read CSV header")
	}
	idx := map[string]int{}
	for i, h := range header {
		idx[strings.ToLower(strings.TrimSpace(h))] = i
	}
	barcodeIdx, ok := idx["barcode"]
	if !ok {
		return nil, errors.New("CSV must have a barcode column")
	}
	nameIdx, ok := idx["name"]
	if !ok {
		return nil, errors.New("CSV must have a name column")
	}
	descIdx, hasDesc := idx["description"]

	seen := map[string]bool{}
	var items []itemCSV
	rowNum := 1
	for {
		rowNum++
		row, err := r.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("invalid CSV row %d", rowNum)
		}
		if barcodeIdx >= len(row) || nameIdx >= len(row) {
			return nil, fmt.Errorf("missing columns on row %d", rowNum)
		}
		barcode := normalizeBarcode(row[barcodeIdx])
		name := strings.TrimSpace(row[nameIdx])
		if barcode == "" || name == "" {
			return nil, fmt.Errorf("barcode and name are required on row %d", rowNum)
		}
		if seen[barcode] {
			return nil, fmt.Errorf("duplicate barcode %q on row %d", barcode, rowNum)
		}
		seen[barcode] = true
		desc := ""
		if hasDesc && descIdx < len(row) {
			desc = strings.TrimSpace(row[descIdx])
		}
		items = append(items, itemCSV{Barcode: barcode, Name: name, Description: desc})
	}
	if len(items) == 0 {
		return nil, errors.New("CSV contains no items")
	}
	return items, nil
}

func (a *App) deleteItems(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		adminError(w, r, "Invalid form")
		return
	}
	ids := r.Form["item_ids"]
	if len(ids) == 0 {
		adminError(w, r, "No items selected")
		return
	}

	// Build safe placeholders
	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args[i] = id
	}
	inClause := strings.Join(placeholders, ",")

	// Check if any selected item is already scanned
	var scannedCount int
	query := fmt.Sprintf(`SELECT COUNT(*) FROM scans WHERE item_id IN (%s)`, inClause)
	if err := a.db.QueryRow(query, args...).Scan(&scannedCount); err != nil {
		adminError(w, r, "Database error")
		return
	}
	if scannedCount > 0 {
		adminError(w, r, fmt.Sprintf("Cannot delete: %d selected item(s) have already been scanned. Clear their scan marks first.", scannedCount))
		return
	}

	// Safe to delete
	delQuery := fmt.Sprintf(`DELETE FROM items WHERE id IN (%s)`, inClause)
	res, err := a.db.Exec(delQuery, args...)
	if err != nil {
		adminError(w, r, "Could not delete items")
		return
	}
	deleted, _ := res.RowsAffected()
	adminMessage(w, r, fmt.Sprintf("Deleted %d item(s)", deleted))
}

func (a *App) clearScans(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		adminError(w, r, "Invalid form")
		return
	}
	category := strings.ToUpper(strings.TrimSpace(r.FormValue("category")))

	var err error
	var msg string
	if category == "" {
		_, err = a.db.Exec(`DELETE FROM scans`)
		msg = "All scan marks cleared"
	} else {
		// Item names are like "Disc Dhol Dandiya - S001", "Disc Dhol Dandiya - A001"
		// Match: name contains " - S" / " - A" / " - K"
		_, err = a.db.Exec(`
			DELETE FROM scans WHERE item_id IN (
				SELECT id FROM items WHERE name LIKE ?
			)`, "% - "+category+"%")
		msg = "Scan marks cleared for category: " + category
	}
	if err != nil {
		adminError(w, r, "Could not clear scan marks: "+err.Error())
		return
	}
	adminMessage(w, r, msg)
}

func (a *App) currentUser(r *http.Request) (*sessionUser, error) {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return nil, err
	}
	var u sessionUser
	var expires int64
	err = a.db.QueryRow(`
SELECT users.id,users.name,users.login,users.role,sessions.csrf_token,sessions.expires_at
FROM sessions JOIN users ON users.id=sessions.user_id
WHERE sessions.token_hash=?`, tokenHash(c.Value)).
		Scan(&u.ID, &u.Name, &u.Login, &u.Role, &u.CSRF, &expires)
	if err != nil {
		return nil, err
	}
	if time.Now().Unix() >= expires {
		_, _ = a.db.Exec(`DELETE FROM sessions WHERE token_hash=?`, tokenHash(c.Value))
		return nil, errors.New("session expired")
	}
	return &u, nil
}

func (a *App) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, err := a.currentUser(r)
		if err != nil {
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
		ctx := context.WithValue(r.Context(), userContextKey, u)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (a *App) requireAdmin(next http.Handler) http.Handler {
	return a.requireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u := mustUser(r)
		if u.Role != "admin" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	}))
}

func (a *App) requireCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u := mustUser(r)
		token := r.Header.Get("X-CSRF-Token")
		if token == "" {
			_ = r.ParseMultipartForm(maxUploadSize)
			token = r.FormValue("csrf")
		}
		if token == "" || token != u.CSRF {
			http.Error(w, "invalid CSRF token", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func mustUser(r *http.Request) *sessionUser {
	u, ok := r.Context().Value(userContextKey).(*sessionUser)
	if !ok || u == nil {
		panic("authenticated user missing from context")
	}
	return u
}

func (a *App) render(w http.ResponseWriter, name string, data map[string]any) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := a.templates.ExecuteTemplate(w, name, data); err != nil {
		log.Printf("template %s: %v", name, err)
	}
}

func (a *App) health(w http.ResponseWriter, r *http.Request) {
	if err := a.db.PingContext(r.Context()); err != nil {
		http.Error(w, "db unavailable", 503)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return fmt.Sprintf("%x", sum[:])
}

func normalizeBarcode(v string) string {
	return strings.TrimSpace(v)
}

func isSecureRequest(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func adminError(w http.ResponseWriter, r *http.Request, msg string) {
	http.Redirect(w, r, "/admin?error="+urlQueryEscape(msg), http.StatusSeeOther)
}

func adminMessage(w http.ResponseWriter, r *http.Request, msg string) {
	http.Redirect(w, r, "/admin?message="+urlQueryEscape(msg), http.StatusSeeOther)
}

func urlQueryEscape(s string) string {
	r := strings.NewReplacer("%", "%25", " ", "+", "&", "%26", "=", "%3D", "?", "%3F", "#", "%23")
	return r.Replace(s)
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Permissions-Policy", "camera=(self)")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
	})
}
