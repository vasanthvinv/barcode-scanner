// Uses html5-qrcode library (local, no internet needed)
// Docs: https://github.com/mebjas/html5-qrcode

(function loadLib() {
  const s = document.createElement('script');
  s.src = '/static/html5-qrcode.min.js';
  s.onload  = initApp;
  s.onerror = () => {
    document.getElementById('cameraHelp').textContent =
      'Could not load barcode library. Please reload.';
    initApp();
  };
  document.head.appendChild(s);
})();

function initApp() {
  const root       = document.querySelector('.scancontainer');
  const csrf       = root.dataset.csrf;
  const input      = document.getElementById('barcodeInput');
  const startBtn   = document.getElementById('startCamera');
  const stopBtn    = document.getElementById('stopCamera');
  const submit     = document.getElementById('submitBarcode');
  const help       = document.getElementById('cameraHelp');
  const scanLine   = document.getElementById('scanLine');
  const videoHint  = document.getElementById('videoHint');
  const todayCount = document.getElementById('todayCount');

  let scanner     = null;
  let scanning    = false;
  let lastValue   = '';
  let lastAt      = 0;
  let todayScans  = 0;

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
    // Strip Code 128 trailer characters: ]C1, ]C0, ]E0, ]Q0 etc.
    value = value.replace(/\]C[0-9]$/, '').replace(/\]E[0-9]$/, '').replace(/\]Q[0-9]$/, '').trim();
    if (!value) return;
    input.value = value;

    // Debounce: same barcode within 2.5s → skip
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
        if (navigator.vibrate) navigator.vibrate(80);
      } else if (data.status === 'duplicate') {
        showResult('used', '⚠️', 'Already Checked In', data.item, data.message);
        if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
      } else if (data.status === 'not_found') {
        showResult('invalid', '❌', 'Invalid Barcode', '', 'This barcode is not registered.');
        if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 100]);
      } else {
        showResult('error', '⚠️', 'Error', '', data.message || 'Request failed');
      }
    } catch (e) {
      showResult('error', '⚠️', 'Network Error', '', 'Could not reach the server.');
    }
  }

  // ── Manual entry ────────────────────────────────────────

  submit.addEventListener('click', () => {
    lastValue = ''; // reset debounce for manual entry
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
      // Get cameras
      const devices = await Html5Qrcode.getCameras();
      if (!devices || devices.length === 0) {
        help.textContent = 'No camera found. Use manual entry.';
        return;
      }

      // Prefer back/environment camera
      const backCam = devices.find(d =>
        /back|rear|environment/i.test(d.label)
      );
      const camId = backCam ? backCam.id : devices[0].id;

      scanner = new Html5Qrcode('video');
      scanning = true;
      startBtn.disabled = true;
      stopBtn.disabled  = false;
      help.textContent  = '';
      if (videoHint) videoHint.textContent = 'Align barcode within the frame';
      if (scanLine) scanLine.classList.add('active');

      await scanner.start(
        camId,
        {
          fps: 15,
          qrbox: { width: 280, height: 160 },  // wider for barcodes
          aspectRatio: 1.333,
          disableFlip: false,
        },
        (decodedText) => {
          checkBarcode(decodedText);
        },
        (_errorMsg) => {
          // scan attempt errors — ignore, keep scanning
        }
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
    if (scanLine) scanLine.classList.remove('active');
    if (videoHint) videoHint.textContent = 'Point barcode at the frame';
    startBtn.disabled = false;
    stopBtn.disabled  = true;
  }
}
