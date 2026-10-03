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

  // ── API call ────────────────────────────────────────────

  async function checkBarcode(value) {
    value = value.trim();
    value = value.replace(/^\][A-Z][0-9]/, '').replace(/\][A-Z][0-9]$/, '').trim();
    if (!value) return;
    input.value = value;

    const now = Date.now();
    if (value === lastValue && now - lastAt < 2500) return;
    lastValue = value;
    lastAt    = now;

    showResult('pending', '⏳', 'Checking…', value, '');
    try {
      const res  = await fetch('/api/scan', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body:    JSON.stringify({ barcode: value }),
      });
      const data = await res.json();

      if (data.status === 'success') {
        showResult('valid', '✅', 'Valid — Entry Allowed', data.item, data.message);
        todayScans++;
        todayCount.textContent = todayScans;
        if (badge) badge.textContent = todayScans;
        playSound('valid');
        if (navigator.vibrate) navigator.vibrate(80);
      } else if (data.status === 'duplicate') {
        showResult('used', '⚠️', 'Already Checked In', data.item, data.message);
        playSound('used');
        if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
      } else if (data.status === 'not_found') {
        showResult('invalid', '❌', 'Invalid Barcode', '', 'This barcode is not registered.');
        playSound('invalid');
        if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 100]);
      } else {
        showResult('error', '⚠️', 'Error', '', data.message || 'Request failed');
        playSound('invalid');
      }
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
        (decodedText) => { checkBarcode(decodedText); },
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
