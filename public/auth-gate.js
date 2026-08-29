// Pictaria password gate: one consistent, blocking "enter the app password"
// prompt for every page, replacing the easy-to-miss top-bar field. Pages
// call window.pictariaGate.show() when the API answers 401 (or no password
// is stored); the gate sends the password to the server, which answers with
// an HttpOnly session cookie (so <img>/EventSource requests authenticate
// too — the browser never stores the raw password), and reloads the page so
// every feature initializes normally.
(() => {
  let overlay = null;

  function build() {
    if (overlay) {
      return;
    }
    const style = document.createElement('style');
    style.textContent = `
      .gate-backdrop {
        position: fixed; inset: 0; z-index: 200;
        background: color-mix(in srgb, var(--p-bg) 82%, transparent);
        backdrop-filter: blur(7px); -webkit-backdrop-filter: blur(7px);
        display: flex; align-items: center; justify-content: center; padding: 24px;
      }
      .gate {
        background: var(--p-bg); border: 1px solid var(--p-line); border-radius: 15px;
        box-shadow: 0 12px 50px rgba(0, 0, 0, 0.5);
        width: min(360px, 100%); padding: 30px 30px 26px; text-align: center;
      }
      .gate .gate-mark { width: 52px; height: 52px; }
      .gate h2 { margin: 12px 0 4px; font-size: 18px; }
      .gate p { margin: 0 0 18px; color: var(--p-muted); font-size: 13px; line-height: 1.45; }
      .gate .p-input { width: 100%; box-sizing: border-box; text-align: center; font-size: 15px; height: 40px; }
      .gate .p-btn { width: 100%; margin-top: 10px; height: 38px; font-size: 14px; }
      .gate .gate-err { color: #e08585; font-size: 12.5px; margin-top: 10px; }
    `;
    document.head.append(style);

    overlay = document.createElement('div');
    overlay.className = 'gate-backdrop';
    overlay.hidden = true;
    const panel = document.createElement('div');
    panel.className = 'gate';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    const mark = document.createElement('img');
    mark.className = 'gate-mark';
    mark.src = '/brand/mark-128.png';
    mark.alt = '';
    const title = document.createElement('h2');
    title.textContent = 'Pictaria';
    const hint = document.createElement('p');
    hint.textContent = 'Enter the app password to continue.';
    const input = document.createElement('input');
    input.className = 'p-input';
    input.type = 'password';
    input.placeholder = 'App password';
    input.autocomplete = 'current-password';
    const button = document.createElement('button');
    button.className = 'p-btn primary';
    button.type = 'button';
    button.textContent = 'Connect';
    const err = document.createElement('div');
    err.className = 'gate-err';
    err.hidden = true;
    panel.append(mark, title, hint, input, button, err);
    overlay.append(panel);
    document.body.append(overlay);

    async function connect() {
      const value = input.value.trim();
      if (!value) {
        input.focus();
        return;
      }
      button.disabled = true;
      err.hidden = true;
      try {
        // The server verifies the password and answers with an HttpOnly
        // session cookie — the browser never stores the password itself.
        const response = await fetch('/api/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: value }),
        });
        if (response.status === 401) {
          err.textContent = "That password didn't match — try again.";
          err.hidden = false;
          input.select();
          return;
        }
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        // Clean up artifacts of the old scheme (raw password in storage).
        localStorage.removeItem('pictariaAppPassword');
        window.location.reload();
      } catch {
        err.textContent = 'Could not reach Pictaria Server.';
        err.hidden = false;
      } finally {
        button.disabled = false;
      }
    }

    button.addEventListener('click', connect);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        connect();
      }
    });
  }

  window.pictariaGate = {
    show() {
      build();
      overlay.hidden = false;
      document.body.style.overflow = 'hidden';
      overlay.querySelector('input').focus();
    },
  };

  // Legacy migration: the old scheme kept the raw password in localStorage,
  // and browsers whose stored credential still works never see the gate's
  // login handler — so they would keep the raw password forever. On every
  // load, exchange the leftover key for an HttpOnly session cookie and only
  // then remove it. This runs async, after page scripts have already read the
  // key into memory, so in-flight header auth keeps working for the rest of
  // the page's life; every later load rides the session cookie.
  async function purgeLegacyPassword() {
    const legacyPassword = localStorage.getItem('pictariaAppPassword');
    if (legacyPassword === null) {
      return;
    }
    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: legacyPassword }),
      });
      // ok: a session cookie now covers future loads (or the server runs
      // open). 401: the stored password is stale and useless — the gate will
      // collect a fresh one. Either way the raw password can go. Other
      // statuses (e.g. 429 lockout) keep it for the next load's attempt.
      if (response.ok || response.status === 401) {
        localStorage.removeItem('pictariaAppPassword');
      }
    } catch {
      // Unreachable server: try again on the next page load.
    }
  }
  void purgeLegacyPassword();

  // Open-mode warning: when the server runs without a password, every page
  // says so at the top. Deliberate open mode is possible (APP_PASSWORD set
  // empty), so warn loudly but do not block.
  async function warnIfOpen() {
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      if (!response.ok) return;
      const health = await response.json();
      if (health.authRequired !== false) return;
      const banner = document.createElement('div');
      banner.setAttribute('role', 'alert');
      banner.style.cssText = 'background: #7f1d1d; color: #fecaca; font-size: 13px; font-weight: 600; '
        + 'padding: 8px 18px; text-align: center; line-height: 1.45;';
      banner.textContent = 'Pictaria is running without a password — anyone on your network can browse your photos '
        + 'and change your Immich library. Set APP_PASSWORD in the server environment to lock it down.';
      document.body.prepend(banner);
    } catch {
      // Unreachable server: the page has bigger problems than this banner.
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void warnIfOpen());
  } else {
    void warnIfOpen();
  }
})();
