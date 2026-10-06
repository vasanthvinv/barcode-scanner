// Uses html5-qrcode library (local, no internet needed)

(function loadLib() {
  const s = document.createElement('script');
  s.src = '/static/html5-qrcode.min.js';
  s.onload  = initApp;
  s.onerror = () => {
    const h = document.getElementById('cameraHelp');
    if (h) h.textContent = 'Could not load barcode library. Please reload.';
    initApp();
  };
  document.head.appendChild(s);
})();

function initApp() {
  const root       = document.querySelector('.scancontainer');
  const csrf       = root.dataset.csrf;
  const isAdmin    = root.dataset.role === 'admin';
  const input      = document.getElementById('barcodeInput');
  const startBtn   = document.getElementById('startCamera');
  const stopBtn    = document.getElementById('stopCamera');
  const submit     = document.getElementById('submitBarcode');
  const help       = document.getElementById('cameraHelp');
  const scanLine   = document.getElementById('scanLine');
  const videoHint  = document.getElementById('videoHint');
  const todayCount = document.getElementById('todayCount');
  const badge      = document.getElementById('scannedBadge');

  let scanner    = null;
  let scanning   = false;
  let lastValue  = '';
  let lastAt     = 0;
  let todayScans = 0;
  let audioCtx   = null;

  // ── Scan page tabs ──────────────────────────────────────

  document.querySelectorAll('.scan-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.scan-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.stab;
      document.getElementById('stab-scan').style.display    = tab === 'scan'    ? '' : 'none';
      document.getElementById('stab-scanned').style.display = tab === 'scanned' ? '' : 'none';
      if (tab === 'scanned') loadScannedList();
    });
  });

  // ── Sound feedback ──────────────────────────────────────

  function playSound(type) {
    try {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AC();
      }
      const ctx  = audioCtx;
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'valid') {
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.35);
      } else if (type === 'used') {
        osc.frequency.setValueAtTime(660, ctx.currentTime);
        osc.frequency.setValueAtTime(440, ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.35);
      } else if (type === 'invalid') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, ctx.currentTime);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.5);
      }
    } catch(_) {}
  }

  // ── Result display ──────────────────────────────────────

  function showResult(kind, icon, title, item, msg) {
    const card = document.getElementById('result');
    card.className = 'result-card ' + kind;
    card.style.display = 'block';
    document.getElementById('resultIcon').textContent  = icon;
    document.getElementById('resultTitle').textContent = title;
    document.getElementById('resultItem').textContent  = item || '';
    document.getElementById('resultMsg').textContent   = msg  || '';
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ── Pass selection UI ───────────────────────────────────
  // Shown when OCR fails and multiple passes share a barcode.

  function showPassSelection(barcode, matches) {
    // Pause camera scanning while selection is shown to prevent re-trigger.
    pauseCameraScanning();

    // Hide the normal result card.
    const resultCard = document.getElementById('result');
    resultCard.style.display = 'none';

    // Build or reuse the selection panel.
    let panel = document.getElementById('passSelectionPanel');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'passSelectionPanel';
      panel.className = 'pass-selection-panel';
      // Insert it right after the result card in the DOM.
      resultCard.parentNode.insertBefore(panel, resultCard.nextSibling);
    }

    // Check if ALL passes are already scanned.
    const allScanned = matches.every(m => m.scanned);

    // Build the header.
    let html = `
      <div class="psp-header">
        <div class="psp-barcode-label">Barcode detected</div>
        <div class="psp-barcode-value">${esc(barcode)}</div>
        <div class="psp-ocr-notice">⚠️ Pass No could not be detected via OCR</div>
      </div>`;

    if (allScanned) {
      html += `<div class="psp-all-scanned">ALL MATCHING PASSES ALREADY SCANNED</div>`;
    } else {
      html += `<div class="psp-subtitle">Multiple tickets use this barcode. Select the correct pass:</div>`;
    }

    // Unscanned passes first (already sorted by server), then scanned ones.
    matches.forEach((m, idx) => {
      const scanned = m.scanned;
      const cardClass = scanned ? 'pass-card pass-card--scanned' : 'pass-card';
      const statusBadge = scanned
        ? `<span class="pass-status-badge pass-status-badge--used">ALREADY SCANNED</span>`
        : `<span class="pass-status-badge pass-status-badge--ok">NOT SCANNED</span>`;
      const scanMeta = scanned && m.scanned_by
        ? `<div class="pass-scan-meta">Scanned by ${esc(m.scanned_by)}${m.scanned_at ? ' at ' + formatTime(m.scanned_at) : ''}</div>`
        : '';
      const btn = scanned
        ? `<button type="button" class="pass-select-btn pass-select-btn--used" disabled>ALREADY USED</button>`
        : `<button type="button" class="pass-select-btn" data-idx="${idx}">SELECT</button>`;

      html += `
        <div class="${cardClass}">
          <div class="pass-card-top">
            <div class="pass-info">
              <div class="pass-no">${esc(m.pass_no || '(no pass no)')}</div>
              <div class="pass-name">${esc(m.name)}</div>
            </div>
            ${statusBadge}
          </div>
          ${scanMeta}
          <div class="pass-card-bottom">${btn}</div>
        </div>`;
    });

    html += `<button type="button" class="psp-cancel-btn" id="pspCancel">✕ Cancel — scan again</button>`;
    panel.innerHTML = html;
    panel.style.display = 'block';
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    // Wire SELECT buttons.
    panel.querySelectorAll('.pass-select-btn[data-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        const match = matches[parseInt(btn.dataset.idx, 10)];
        closePassSelection();
        submitWithPassNo(barcode, match.pass_no);
      });
    });

    // Wire cancel.
    document.getElementById('pspCancel').addEventListener('click', () => {
      closePassSelection();
      resumeCameraScanning();
      // Reset debounce so the same barcode can be scanned again.
      lastValue = '';
    });
  }

  function closePassSelection() {
    const panel = document.getElementById('passSelectionPanel');
    if (panel) panel.style.display = 'none';
  }

  // ── Camera scanning pause/resume (used during pass selection) ──

  let cameraPaused = false;

  function pauseCameraScanning() {
    cameraPaused = true;
  }

  function resumeCameraScanning() {
    cameraPaused = false;
  }

  // ── Submit a confirmed barcode + pass_no to /api/scan ───

  async function submitWithPassNo(barcode, passNo) {
    showResult('pending', '⏳', 'Checking…', barcode, passNo ? `Pass: ${passNo}` : '');
    try {
      const res  = await fetch('/api/scan', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body:    JSON.stringify({ barcode, pass_no: passNo }),
      });
      const data = await res.json();
      handleScanResponse(data, barcode);
    } catch (e) {
      showResult('error', '⚠️', 'Network Error', '', 'Could not reach the server.');
    }
  }

  // ── Handle a /api/scan response ─────────────────────────

  function handleScanResponse(data, barcode) {
    if (data.status === 'success') {
      const label = data.pass_no ? `${data.item} — ${data.pass_no}` : data.item;
      showResult('valid', '✅', 'Valid — Entry Allowed', label, data.message);
      todayScans++;
      todayCount.textContent = todayScans;
      if (badge) badge.textContent = todayScans;
      playSound('valid');
      if (navigator.vibrate) navigator.vibrate(80);
      resumeCameraScanning();

    } else if (data.status === 'duplicate') {
      const label = data.pass_no ? `${data.item} — ${data.pass_no}` : data.item;
      showResult('used', '⚠️', 'Already Checked In', label, data.message);
      playSound('used');
      if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
      resumeCameraScanning();

    } else if (data.status === 'not_found') {
      showResult('invalid', '❌', 'Invalid Barcode', '', 'This barcode is not registered.');
      playSound('invalid');
      if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 100]);
      resumeCameraScanning();

    } else if (data.status === 'mismatch') {
      showResult('invalid', '❌', 'Pass / Barcode Mismatch', '', data.message || 'No record matches this combination.');
      playSound('invalid');
      if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 100]);
      resumeCameraScanning();

    } else if (data.status === 'needs_selection') {
      // Server says: multiple passes share this barcode — fetch the list and show UI.
      fetchAndShowPassSelection(barcode);

    } else {
      showResult('error', '⚠️', 'Error', '', data.message || 'Request failed');
      playSound('invalid');
      resumeCameraScanning();
    }
  }

  // ── Fetch pass list and show selection UI ───────────────

  async function fetchAndShowPassSelection(barcode) {
    showResult('pending', '⏳', 'Multiple passes found…', barcode, 'Please select the correct pass below.');
    try {
      const res  = await fetch('/api/scan/lookup', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body:    JSON.stringify({ barcode }),
      });
      const data = await res.json();
      if (data.status === 'ok' && Array.isArray(data.matches) && data.matches.length > 0) {
        showPassSelection(barcode, data.matches);
      } else {
        showResult('invalid', '❌', 'Invalid Barcode', '', 'This barcode is not registered.');
        playSound('invalid');
        resumeCameraScanning();
      }
    } catch (e) {
      showResult('error', '⚠️', 'Network Error', '', 'Could not reach the server.');
      resumeCameraScanning();
    }
  }

  // ── Primary API call ────────────────────────────────────
  // Triggered by camera scan or manual entry.
  // pass_no is intentionally omitted here — it comes from OCR (future) or
  // from the selection UI callback above.

  async function checkBarcode(value) {
    value = value.trim();
    value = value.replace(/^\][A-Z][0-9]/, '').replace(/\][A-Z][0-9]$/, '').trim();
    if (!value) return;
    input.value = value;

    const now = Date.now();
    if (value === lastValue && now - lastAt < 2500) return;
    lastValue = value;
    lastAt    = now;

    // Close any open selection panel before starting a new scan.
    closePassSelection();
    resumeCameraScanning();

    showResult('pending', '⏳', 'Checking…', value, '');
    try {
      const res  = await fetch('/api/scan', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body:    JSON.stringify({ barcode: value }),
      });
      const data = await res.json();
      handleScanResponse(data, value);
    } catch (e) {
      showResult('error', '⚠️', 'Network Error', '', 'Could not reach the server.');
    }
  }

  // ── Scanned list ────────────────────────────────────────

  async function loadScannedList() {
    const list = document.getElementById('scannedList');
    if (!list) return;
    try {
      const res  = await fetch('/api/scans/today');
      const data = await res.json();

      if (!data.length) {
        list.innerHTML = '<p class="muted small center-text" style="padding:1rem">No scans today.</p>';
        return;
      }

      const sub = document.getElementById('scannedSubtitle');
      if (sub) sub.textContent = `Today's scans — ${data.length} total`;
      if (badge) badge.textContent = data.length;
      todayScans = data.length;
      todayCount.textContent = data.length;

      list.innerHTML = data.map(s => `
        <div class="scanned-row" data-id="${s.id}">
          <div class="scanned-info">
            <span class="scanned-name">${esc(s.name)}</span>
            <span class="scanned-meta">${esc(s.scanned_by)} · ${formatTime(s.scanned_at)}</span>
          </div>
          ${isAdmin ? `<button type="button" class="undo-btn" data-id="${s.id}" data-name="${esc(s.name)}">↩ Undo</button>` : ''}
        </div>`).join('');

      // Undo button listeners
      list.querySelectorAll('.undo-btn').forEach(btn => {
        btn.addEventListener('click', () => undoScan(btn.dataset.id, btn.dataset.name));
      });

    } catch(e) {
      list.innerHTML = '<p class="muted small center-text" style="padding:1rem">Could not load scans.</p>';
    }
  }

  async function undoScan(scanId, name) {
    if (!confirm(`Undo scan for "${name}"?\n\nThis will mark the ticket as unused again.`)) return;
    try {
      const res  = await fetch('/api/scan/undo', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': csrf },
        body:    `scan_id=${encodeURIComponent(scanId)}`,
      });
      const data = await res.json();
      if (data.ok) {
        // Remove row from list
        const row = document.querySelector(`.scanned-row[data-id="${scanId}"]`);
        if (row) row.remove();
        // Update count
        const remaining = document.querySelectorAll('.scanned-row').length;
        if (badge) badge.textContent = remaining;
        todayScans = Math.max(0, todayScans - 1);
        todayCount.textContent = todayScans;
        const sub = document.getElementById('scannedSubtitle');
        if (sub) sub.textContent = `Today's scans — ${remaining} total`;
      } else {
        alert('Undo failed: ' + (data.error || 'unknown error'));
      }
    } catch(e) {
      alert('Network error');
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>'"]/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  }

  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts.replace(' ', 'T') + 'Z');
    return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  // ── Manual entry ────────────────────────────────────────

  submit.addEventListener('click', () => {
    lastValue = '';
    checkBarcode(input.value);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { lastValue = ''; checkBarcode(input.value); }
  });

  // ── Camera start ────────────────────────────────────────

  startBtn.addEventListener('click', async () => {
    if (!window.Html5Qrcode) {
      help.textContent = 'Barcode library not loaded. Use manual entry.';
      return;
    }
    try {
      const devices = await Html5Qrcode.getCameras();
      if (!devices || devices.length === 0) {
        help.textContent = 'No camera found. Use manual entry.';
        return;
      }
      const backCam = devices.find(d => /back|rear|environment/i.test(d.label));
      const camId   = backCam ? backCam.id : devices[0].id;

      scanner = new Html5Qrcode('video');
      scanning = true;
      startBtn.disabled = true;
      stopBtn.disabled  = false;
      help.textContent  = '';
      if (videoHint) videoHint.textContent = 'Align barcode within the frame';
      if (scanLine)  scanLine.classList.add('active');

      await scanner.start(
        camId,
        { fps: 15, qrbox: { width: 280, height: 160 }, aspectRatio: 1.333 },
        (decodedText) => {
          // While operator is choosing a pass, ignore new camera reads.
          if (!cameraPaused) {
            checkBarcode(decodedText);
          }
        },
        (_err) => {}
      );
    } catch (e) {
      help.textContent  = 'Could not start camera: ' + (e.message || String(e));
      startBtn.disabled = false;
      stopBtn.disabled  = true;
      if (scanLine) scanLine.classList.remove('active');
    }
  });

  // ── Camera stop ─────────────────────────────────────────

  stopBtn.addEventListener('click', stopCamera);

  async function stopCamera() {
    if (scanner && scanning) {
      try { await scanner.stop(); } catch(_) {}
      try { scanner.clear(); }     catch(_) {}
      scanner  = null;
      scanning = false;
    }
    cameraPaused = false;
    if (scanLine)  scanLine.classList.remove('active');
    if (videoHint) videoHint.textContent = 'Point barcode at the frame';
    startBtn.disabled = false;
    stopBtn.disabled  = true;
  }

  // Load initial today count
  fetch('/api/scans/today')
    .then(r => r.json())
    .then(data => {
      if (data.length) {
        todayScans = data.length;
        todayCount.textContent = data.length;
        if (badge) badge.textContent = data.length;
      }
    }).catch(() => {});
}
