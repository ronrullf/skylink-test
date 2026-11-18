/**
 * SkyPayScanner — Motor compartido de escaneo de Códigos de Barras y QR
 * 100% local (sin CDN): usa BarcodeDetector polyfill (/barcode-detector.iife.js + /zxing_reader.wasm)
 * con respaldo ZXing JS (/zxing.min.js), cascada de cámara de 4 niveles para Android y sensores VGA/480p,
 * realce adaptativo de contraste, auto-zoom y tap-to-focus.
 */
(function (global) {
  'use strict';

  const DEFAULT_FORMATS = [
    'ean_13', 'ean_8', 'upc_a', 'upc_e',
    'code_128', 'code_39', 'code_93', 'itf', 'codabar',
    'qr_code', 'micro_qr_code', 'data_matrix', 'pdf417', 'aztec'
  ];

  // Configurar ruta local del binario WASM para barcode-detector
  if (global.BarcodeDetectorPolyfill && typeof global.BarcodeDetectorPolyfill.setZXingModuleOverrides === 'function') {
    global.BarcodeDetectorPolyfill.setZXingModuleOverrides({
      locateFile: (path, prefix) => (path.endsWith('.wasm') ? '/zxing_reader.wasm' : prefix + path)
    });
  }

  let sharedDetector = null;
  let sharedZxingReader = null;

  function getDetector() {
    if (sharedDetector) return sharedDetector;
    const Cls = (global.BarcodeDetectorPolyfill && global.BarcodeDetectorPolyfill.BarcodeDetector) || global.BarcodeDetector;
    if (!Cls) return null;
    try {
      sharedDetector = new Cls({ formats: DEFAULT_FORMATS });
    } catch {
      try {
        sharedDetector = new Cls({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
      } catch {
        sharedDetector = new Cls();
      }
    }
    return sharedDetector;
  }

  function getZxingFallback() {
    if (sharedZxingReader) return sharedZxingReader;
    if (global.ZXing && global.ZXing.BrowserMultiFormatReader) {
      try {
        const hints = new Map();
        if (global.ZXing.DecodeHintType) {
          hints.set(global.ZXing.DecodeHintType.TRY_HARDER, true);
        }
        sharedZxingReader = new global.ZXing.BrowserMultiFormatReader(hints);
      } catch {
        sharedZxingReader = new global.ZXing.BrowserMultiFormatReader();
      }
    }
    return sharedZxingReader;
  }

  function realzarContrasteBajaResolucion(ctx, w, h) {
    try {
      const imgData = ctx.getImageData(0, 0, w, h);
      const data = imgData.data;
      let minLum = 255;
      let maxLum = 0;

      for (let i = 0; i < data.length; i += 16) {
        const lum = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
      }

      const diff = maxLum - minLum;
      if (diff > 18 && diff < 195) {
        const scale = 255 / diff;
        for (let i = 0; i < data.length; i += 4) {
          const lum = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
          const stretched = Math.min(255, Math.max(0, ((lum - minLum) * scale) | 0));
          data[i] = stretched;
          data[i + 1] = stretched;
          data[i + 2] = stretched;
        }
        ctx.putImageData(imgData, 0, 0);
        return true;
      }
    } catch {}
    return false;
  }

  async function solicitarStreamCamaraRobusto() {
    const perfiles = [
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, min: 10 } }, audio: false },
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
      { video: true, audio: false }
    ];

    let lastError = null;
    for (const config of perfiles) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(config);
        if (stream) return stream;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('No se pudo acceder a ninguna cámara.');
  }

  class SkyPayScanner {
    constructor(options = {}) {
      this.video = options.videoEl;
      this.viewport = options.viewportEl || null;
      this.onDetect = options.onDetect || (() => {});
      this.onStatus = options.onStatus || (() => {});
      this.onError = options.onError || (() => {});
      this.cooldownMs = options.cooldownMs || 1400;
      this.minIntervalMs = options.minIntervalMs || 60;

      this.stream = null;
      this.track = null;
      this.running = false;
      this.busy = false;
      this.lastScanTime = 0;
      this.lastCode = '';
      this.lastCodeAt = 0;
      this.torchOn = false;
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      this.rafId = null;
    }

    async start() {
      if (this.running && this.stream && this.stream.active) return;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const msg = 'Tu navegador no permite acceso a la cámara (usa HTTPS o localhost).';
        this.onError(msg);
        throw new Error(msg);
      }

      this.onStatus('Conectando cámara…', false);
      this.video.setAttribute('playsinline', 'true');
      this.video.setAttribute('webkit-playsinline', 'true');
      this.video.muted = true;

      try {
        this.stream = await solicitarStreamCamaraRobusto();
        this.video.srcObject = this.stream;
        await this.video.play();

        if (!this.video.videoWidth) {
          await new Promise(resolve => {
            this.video.onloadedmetadata = () => resolve();
            setTimeout(resolve, 600);
          });
        }

        const [track] = this.stream.getVideoTracks();
        this.track = track || null;
        if (this.track && typeof this.track.applyConstraints === 'function') {
          try {
            const caps = this.track.getCapabilities ? this.track.getCapabilities() : {};
            if (caps.focusMode && Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
              await this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
            }
          } catch {}
        }

        this.running = true;
        this.onStatus('Escáner activo', true);
        this._bindTapToFocus();
        this._loop();
      } catch (err) {
        this.onStatus('Cámara no disponible', false);
        this.onError(err.message || 'No se pudo iniciar la cámara.');
        throw err;
      }
    }

    stop() {
      this.running = false;
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      if (this.stream) {
        this.stream.getTracks().forEach(t => t.stop());
        this.stream = null;
      }
      this.track = null;
      this.torchOn = false;
      if (this.video) this.video.srcObject = null;
      this.onStatus('Cámara en pausa', false);
    }

    supportsTorch() {
      try {
        const caps = this.track && this.track.getCapabilities ? this.track.getCapabilities() : {};
        return Boolean(caps.torch);
      } catch {
        return false;
      }
    }

    async toggleTorch() {
      if (!this.track) return false;
      try {
        this.torchOn = !this.torchOn;
        await this.track.applyConstraints({ advanced: [{ torch: this.torchOn }] });
        return this.torchOn;
      } catch {
        this.torchOn = false;
        return false;
      }
    }

    _bindTapToFocus() {
      if (!this.viewport || this.viewport._skypayTapBound) return;
      this.viewport._skypayTapBound = true;
      this.viewport.addEventListener('click', async (e) => {
        if (e.target.closest('button')) return;
        if (this.track && typeof this.track.applyConstraints === 'function') {
          try {
            const caps = this.track.getCapabilities ? this.track.getCapabilities() : {};
            if (caps.focusMode && Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
              await this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
            }
          } catch {}
        }
      });
    }

    _loop() {
      if (!this.running) return;
      const now = performance.now();
      if (!this.busy && now - this.lastScanTime >= this.minIntervalMs) {
        this.busy = true;
        this.lastScanTime = now;
        this._scanFrame().finally(() => {
          this.busy = false;
        });
      }
      this.rafId = requestAnimationFrame(() => this._loop());
    }

    async _scanFrame() {
      if (!this.video || this.video.readyState < 2 || !this.video.videoWidth) return;
      const detector = getDetector();
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;

      const sx = Math.floor(vw * 0.06);
      const sy = Math.floor(vh * 0.12);
      const sw = Math.floor(vw * 0.88);
      const sh = Math.floor(vh * 0.76);
      const scale = Math.min(1, 960 / Math.max(sw, sh));
      const rw = Math.max(160, Math.floor(sw * scale));
      const rh = Math.max(120, Math.floor(sh * scale));

      if (this.canvas.width !== rw || this.canvas.height !== rh) {
        this.canvas.width = rw;
        this.canvas.height = rh;
      }

      this.ctx.drawImage(this.video, sx, sy, sw, sh, 0, 0, rw, rh);

      let barcodes = [];
      if (detector) {
        try { barcodes = await detector.detect(this.canvas); } catch {}
      }

      if (!barcodes || barcodes.length === 0) {
        const fb = getZxingFallback();
        if (fb) {
          try {
            const res = fb.decodeFromCanvas(this.canvas);
            if (res && res.getText()) {
              barcodes = [{ rawValue: res.getText(), format: String(res.getBarcodeFormat()) }];
            }
          } catch {}
        }
      }

      if (!barcodes || barcodes.length === 0) {
        const enhanced = realzarContrasteBajaResolucion(this.ctx, rw, rh);
        if (enhanced) {
          if (detector) {
            try { barcodes = await detector.detect(this.canvas); } catch {}
          }
          if ((!barcodes || barcodes.length === 0)) {
            const fb = getZxingFallback();
            if (fb) {
              try {
                const res = fb.decodeFromCanvas(this.canvas);
                if (res && res.getText()) {
                  barcodes = [{ rawValue: res.getText(), format: String(res.getBarcodeFormat()) }];
                }
              } catch {}
            }
          }
        }
      }

      if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
        const code = String(barcodes[0].rawValue).trim();
        const now = Date.now();
        if (code && (code !== this.lastCode || (now - this.lastCodeAt) > this.cooldownMs)) {
          this.lastCode = code;
          this.lastCodeAt = now;
          this.onDetect(code, barcodes[0].format || 'unknown');
        }
      }
    }
  }

  global.SkyPayScanner = SkyPayScanner;
  global.SkyPayScannerUtils = {
    solicitarStreamCamaraRobusto,
    realzarContrasteBajaResolucion,
    getDetector,
    getZxingFallback
  };
})(window);
