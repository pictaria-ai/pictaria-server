// Mobile nav: below 720px the topbar page links collapse behind a hamburger
// button at the far right (companion @media rules live in pictaria.css).
(function () {
  function init() {
    const topbar = document.querySelector('.p-topbar');
    const nav = topbar ? topbar.querySelector('.p-nav') : null;
    if (!topbar || !nav) return;
    const button = document.createElement('button');
    button.className = 'p-nav-burger';
    button.type = 'button';
    button.setAttribute('aria-label', 'Pages');
    button.textContent = '☰';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      nav.classList.toggle('open');
    });
    document.addEventListener('click', (event) => {
      if (!nav.contains(event.target)) nav.classList.remove('open');
    });
    topbar.append(button);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

// Product, license, and source notice shared by every interactive page. It is
// deliberately independent of supporter status and lives outside page-specific
// <main> elements so it remains present across Remote's alternate screens.
(function () {
  function init() {
    if (document.getElementById('legalFooter')) return;

    const footer = document.createElement('footer');
    footer.id = 'legalFooter';
    footer.className = 'p-legal-footer';
    footer.setAttribute('aria-label', 'Pictaria legal information');
    footer.append(`© ${new Date().getFullYear()} Pictaria · `);

    const license = document.createElement('a');
    license.href = 'https://github.com/pictaria-ai/pictaria-server/blob/main/LICENSE';
    license.target = '_blank';
    license.rel = 'noopener';
    license.textContent = 'AGPL-3.0';

    const source = document.createElement('a');
    source.href = 'https://github.com/pictaria-ai/pictaria-server';
    source.target = '_blank';
    source.rel = 'noopener';
    source.textContent = 'Source';

    footer.append(license, ' · ', source);
    const toast = document.querySelector('.p-toast');
    if (toast && toast.parentNode === document.body) {
      document.body.insertBefore(footer, toast);
    } else {
      document.body.append(footer);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

// Supporter badge: a small chip beside the brand once a supporter key is
// entered (Settings → Support Pictaria), plus a quiet support-us footer
// line on every page EXCEPT Remote (a handheld controller surface, not an
// admin page), shown only while there is NO key. Fails silent on any
// error — no badge is ever worth a broken page.
(function () {
  function syncFooter(supporter) {
    let footer = document.getElementById('supportFooter');
    if (!supporter && !footer && !/\/remote\.html$/.test(location.pathname)) {
      const main = document.querySelector('main');
      if (!main) return;
      footer = document.createElement('p');
      footer.id = 'supportFooter';
      footer.style.cssText = 'margin-top: 34px; text-align: center; font-size: 13px; color: var(--p-muted)';
      footer.append('Pictaria Server is independent software. ');
      const link = document.createElement('a');
      link.href = 'https://pictaria.ai/contribute';
      link.target = '_blank';
      link.rel = 'noopener';
      link.style.color = 'var(--p-accent)';
      link.append('Support its development ');
      const mark = document.createElement('img');
      mark.src = '/brand/mark-128.png';
      mark.alt = '';
      mark.style.cssText = 'height: 12px; width: auto; vertical-align: -1px';
      link.append(mark);
      footer.append(link);
      main.append(footer);
    }
    if (footer) footer.hidden = Boolean(supporter);
  }

  // Every page carries a fixed-width slot between the brand and the nav.
  // Patron status can therefore resolve before or after first paint without
  // moving the page links. The cache still avoids an unnecessarily empty
  // slot while the live check corrects a key that was entered or removed.
  const STORAGE_KEY = 'pictariaSupporterStatus';

  function ensureSlot() {
    const topbar = document.querySelector('.p-topbar');
    const brand = topbar?.querySelector('.p-brand');
    if (!topbar || !brand) return null;
    let slot = topbar.querySelector('.p-supporter-slot');
    if (!slot) {
      slot = document.createElement('span');
      slot.className = 'p-supporter-slot';
      slot.setAttribute('aria-live', 'polite');
      brand.after(slot);
    }
    return slot;
  }

  function readCache() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeCache(supporter) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ supporter }));
    } catch { /* silent */ }
  }

  function render(supporter) {
    syncFooter(supporter);
    const slot = ensureSlot();
    if (!slot) return;
    slot.replaceChildren();
    if (!supporter) return;
    const patron = supporter.tier === 'patron';
    const chip = document.createElement('span');
    chip.className = `p-supporter-chip${patron ? ' patron' : ''}`;
    // The Pictaria mark itself (a mosaic butterfly) as the chip icon — at
    // this size the mosaic reads as a colorful butterfly, and it IS the
    // brand rather than an approximation of it.
    const mark = document.createElement('img');
    mark.src = '/brand/mark-128.png';
    mark.alt = '';
    chip.append(mark, patron ? 'Patron' : 'Supporter');
    const since = new Date(supporter.since);
    // timeZone UTC: iat is a date-only string, which parses as UTC
    // midnight — local rendering would show the previous month anywhere
    // west of UTC.
    const sinceText = Number.isNaN(since.getTime())
      ? supporter.since
      : since.toLocaleDateString(undefined, { year: 'numeric', month: 'long', timeZone: 'UTC' });
    chip.title = `Supporting Pictaria since ${sinceText} — thank you!`;
    slot.append(chip);
  }

  async function refresh() {
    try {
      const response = await fetch('/api/support/status', { cache: 'no-store' });
      if (!response.ok) return;
      const { supporter } = await response.json();
      writeCache(supporter || false);
      render(supporter);
    } catch { /* silent */ }
  }

  function boot() {
    const cached = readCache();
    if (cached !== null) render(cached.supporter);
    void refresh();
  }
  window.pictariaSupporter = { refresh };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
