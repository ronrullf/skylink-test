/* Kiosk UI — shared helpers (global, no build step) */
(function () {
  const PHOTOS = [
    { re: /harina/, file: 'harina-pan.png' },
    { re: /nescaf|cafe/, file: 'nescafe-clasico.png' },
    { re: /coca|refresco/, file: 'coca-cola.png' },
    { re: /arroz/, file: 'arroz-mary.png' },
    { re: /^aceite/, file: 'aceite-oleocali.png' },
    { re: /savoy|chocolate/, file: 'savoy.png' }
  ];
  const PHOTO_BY_CODE = { '7591473005492': 'arroz-mary.png' };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Returns a photo URL when we have one for this product, otherwise null.
  function productPhoto(p) {
    if (!p) return null;
    if (PHOTO_BY_CODE[p.code]) return '/kiosco/productos/' + PHOTO_BY_CODE[p.code];
    const name = String(p.name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const hit = PHOTOS.find(x => x.re.test(name));
    return hit ? '/kiosco/productos/' + hit.file : null;
  }

  // Photo when available, emoji fallback otherwise.
  function productVisual(p) {
    const url = productPhoto(p);
    if (url) return '<img src="' + url + '" alt="' + esc(p.name) + '" loading="lazy">';
    return '<span class="emoji" aria-hidden="true">' + esc((p && p.icon) || '📦') + '</span>';
  }

  const fmtBs = n => 'Bs. ' + Number(n || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtUsd = n => '$' + Number(n || 0).toFixed(2);

  function beep(freq, dur) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq || 900;
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + (dur || 0.1));
      osc.start();
      osc.stop(ctx.currentTime + (dur || 0.1));
    } catch (e) { /* audio is optional */ }
  }

  // Modal helper: KioskModal.open({ title, text, primary, primaryClass, secondary, onPrimary })
  const KioskModal = {
    open(opts) {
      this.close();
      const bg = document.createElement('div');
      bg.className = 'modal-bg';
      bg.id = 'kioskModal';
      bg.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true">' +
        '<h2>' + esc(opts.title) + '</h2><p>' + esc(opts.text) + '</p>' +
        '<div class="actions">' +
        '<button type="button" class="m-primary ' + (opts.primaryClass || '') + '" data-act="primary">' + esc(opts.primary) + '</button>' +
        '<button type="button" class="m-secondary" data-act="close">' + esc(opts.secondary || 'Cerrar') + '</button>' +
        '</div></div>';
      bg.addEventListener('click', e => {
        const act = e.target.dataset && e.target.dataset.act;
        if (e.target === bg || act === 'close') return KioskModal.close();
        if (act === 'primary') { KioskModal.close(); if (opts.onPrimary) opts.onPrimary(); }
      });
      document.body.appendChild(bg);
    },
    close() {
      const el = document.getElementById('kioskModal');
      if (el) el.remove();
    },
    help() {
      this.open({
        title: '¿Necesitas ayuda, pana?',
        text: 'Pide asistencia a un asesor de Naguaralabs en la tienda. Tus productos se mantienen seguros en tu cuenta.',
        primary: '¡Entendido, pana!',
        secondary: 'Cerrar'
      });
    }
  };

  // Header info: exchange rate pill + live clock (elements #hdrRate and #hdrClock).
  const KioskHeader = {
    setRate(rate) {
      const el = document.getElementById('hdrRate');
      if (el && Number(rate) > 0) el.textContent = 'Tasa ' + fmtBs(Number(rate));
    },
    startClock() {
      const el = document.getElementById('hdrClock');
      if (!el) return;
      const tick = () => { el.textContent = new Date().toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' }); };
      tick();
      setInterval(tick, 1000);
    },
    // Loads the BCV rate from the API; falls back to the provided rate.
    async init(fallbackRate) {
      this.startClock();
      this.setRate(fallbackRate);
      try {
        const res = await fetch('/api/bcv-rate').then(r => r.json());
        if (res && res.rate) this.setRate(res.rate);
      } catch (e) { /* keep fallback */ }
    }
  };

  window.Kiosk = { esc, productPhoto, productVisual, fmtBs, fmtUsd, beep, KioskModal, KioskHeader };
})();
