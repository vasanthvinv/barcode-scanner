// Load ZXing from local static file (no internet required).
(function loadZxing() {
  const s = document.createElement('script');
  s.src = '/static/zxing.min.js';
  s.onload = initApp;
  s.onerror = () => {
    document.getElementById('cameraHelp').textContent =
      'Could not load barcode library. Please reload the page.';
    initApp();
  };
  document.head.appendChild(s);
})();

function initApp() {
  const root      = document.querySelector('.scancontainer');
  const csrf      = root.dataset.csrf;
  const video     = document.getElementById('video');
  const input     = document.getElementById('barcodeInput');
  const startBtn  = document.getElementById('startCamera');
  const stopBtn   = document.getElementById('stopCamera');
  const submit    = document.getElementById('submitBarcode');
  const help      = document.getElementById('cameraHelp');
  const scanLine  = document.getElementById('scanLine');
  const videoHint = document.getElementById('videoHint');
  const todayCount = document.getElementById('todayCount');

  let reader    = null;
  let lastValue = '';
  let lastAt    = 0;
  let todayScans = 0;

  // ── Result display ─────────────────────────────────────

  function showResult(kind, icon, title, item, msg) {
    const card = document.getElementById('result');
    card.className = 'result-card ' + kind;
    card.classList.remove('hidden');
    document.getElementById('resultIcon').textContent  = icon;
    document.getElementById('resultTitle').textContent = title;
    document.getElementById('resultItem').textContent  = item  || '';
    document.getElementById('resultMsg').textContent   = msg   || '';
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ── API call ────────────────────────────────────────────

  async function checkBarcode(value) {
    value = value.trim();
    if (!value) return;
    input.value = value;
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

  submit.addEventListener('click', () => checkBarcode(input.value));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') checkBarcode(input.value); });

  // ── Camera (ZXing) ──────────────────────────────────────

  startBtn.addEventListener('click', async () => {
    const ZXing = window.ZXingBrowser;
    if (!ZXing || !ZXing.BrowserMultiFormatReader) {
      help.textContent = 'Barcode library not loaded. Manual entry still works.';
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      help.textContent = 'Camera not available. Use manual entry.';
      return;
    }

    try {
      reader = new ZXing.BrowserMultiFormatReader();

      const devices = await navigator.mediaDevices.enumerateDevices()
        .then(d => d.filter(d => d.kind === 'videoinput'));
      const backCam  = devices.find(c => /back|rear|environment/i.test(c.label));
      const deviceId = backCam ? backCam.deviceId : (devices[0] ? devices[0].deviceId : undefined);

      help.textContent = '';
      videoHint.textContent = 'Align barcode within the frame';
      startBtn.disabled = true;
      stopBtn.disabled  = false;
      scanLine.classList.add('active');

      await reader.decodeFromVideoDevice(deviceId, video, (res, err) => {
        if (!res) return;
        const value = res.getText();
        const now   = Date.now();
        if (value && (value !== lastValue || now - lastAt > 2500)) {
          lastValue = value;
          lastAt    = now;
          checkBarcode(value);
        }
      });

    } catch (e) {
      help.textContent = 'Could not start camera: ' + (e.message || e);
      startBtn.disabled = false;
      stopBtn.disabled  = true;
      scanLine.classList.remove('active');
    }
  });

  stopBtn.addEventListener('click', stopCamera);

  function stopCamera() {
    if (reader) {
      try { reader.reset(); } catch(_) {}
      reader = null;
    }
    if (video.srcObject) {
      video.srcObject.getTracks().forEach(t => t.stop());
      video.srcObject = null;
    }
    video.load();
    scanLine.classList.remove('active');
    videoHint.textContent = 'Point barcode at the frame';
    startBtn.disabled = false;
    stopBtn.disabled  = true;
  }
}
