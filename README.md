# Barcode Check

Small Go + SQLite barcode checking application designed for a 512 MB VPS.

## Features

- Bootstrap users from `users.csv` (`name,login,password,role`)
- Passwords are bcrypt-hashed into SQLite on first startup
- Server-side sessions with HttpOnly cookies
- Admin/user roles
- Admin can add/remove users
- Admin can upload/revise an item CSV
- Admin can clear scan marks
- Admin and users can scan barcodes in the browser
- Duplicate and not-found detection
- SQLite unique constraint protects against simultaneous duplicate scans
- HTML/CSS/JS are embedded in the Go executable

## Item CSV

Required columns:

```csv
barcode,name
8901234567890,Blue Shirt
```

Optional column: `description`.

Uploading an item CSV *replaces* the current item list and clears previous scan marks.

## First run

```bash
cp users.csv.example users.csv
# IMPORTANT: edit users.csv and change the passwords before first start
mkdir -p data
go mod tidy
go run .
```

Open http://localhost:8080

After first startup, accounts live in SQLite and new users are managed from the Admin page. The plaintext bootstrap CSV is no longer needed and should be deleted or protected.

## Build for Linux VPS

Because `modernc.org/sqlite` is pure Go, CGO is not required:

```bash
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o barcode-app .
```

For ARM64:

```bash
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o barcode-app .
```

## Production deployment

Recommended layout:

```text
/opt/barcode-app/
  barcode-app
  data/inventory.db
```

Use Caddy for HTTPS and reverse proxy to `127.0.0.1:8080`. Camera APIs generally require HTTPS outside localhost.

The included `barcode-app.service` is a sample systemd unit. Change `barcode.example.com` in the Caddyfile to your real domain.

## Notes

- The app uses SQLite WAL mode and a 5s busy timeout.
- `scans.item_id` is UNIQUE, so a given item can only be marked once even if two scanners submit concurrently.
- The camera page uses the browser's native `BarcodeDetector` API. Manual entry always works. Browser support varies; Chrome/Edge on Android are good targets. If you need Safari/iPhone coverage, add a bundled ZXing decoder instead of relying only on BarcodeDetector.
- Back up `data/inventory.db` regularly.
