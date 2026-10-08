/* Shared helpers for all pages */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtDate(iso, opts) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso || '';
    return d.toLocaleString(undefined, opts || { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  const fmtTime = (iso) => fmtDate(iso, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const fmtFull = (iso) => fmtDate(iso, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const fmtDay = (iso) => fmtDate(iso, { weekday: 'long', month: 'long', day: 'numeric' });
  const fmtClock = (iso) => fmtDate(iso, { hour: 'numeric', minute: '2-digit' });
  const monthShort = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short' }).toUpperCase();
  const dayNum = (iso) => new Date(iso).getDate();

  async function api(method, url, body, headers = {}) {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      const err = new Error(json?.message || `Request failed (${res.status})`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  let toastTimer;
  function toast(msg, ms = 2800) {
    let el = $('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  const catSlug = (c) => String(c || 'general').toLowerCase().replace(/[^a-z]/g, '') || 'general';

  function capacityClass(ev) {
    if (ev.remaining === 0) return 'full';
    if (ev.remaining / ev.capacity <= 0.15) return 'tight';
    return '';
  }

  const I = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  const icons = {
    cal: I('<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/>'),
    pin: I('<path d="M12 22s7-6.3 7-12a7 7 0 1 0-14 0c0 5.7 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>'),
    users: I('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 20a5 5 0 0 1 6-4.6"/>'),
    clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    arrow: I('<path d="M5 12h14M13 6l6 6-6 6"/>', 'class="arrow"'),
    ticket: I('<path d="M3 9a2 2 0 0 0 2-2V5h14v2a2 2 0 0 0 0 4v2a2 2 0 0 0 0 4v2H5v-2a2 2 0 0 0-2-2z"/><path d="M13 5v14" stroke-dasharray="2 3"/>'),
    check: I('<path d="m5 12 5 5L20 7"/>'),
    x: I('<path d="M6 6l12 12M18 6 6 18"/>'),
    repeat: I('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
    search: I('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    sun: I('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    moon: I('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
    camera: I('<path d="M4 8h3l2-3h6l2 3h3v12H4z"/><circle cx="12" cy="13" r="3.5"/>'),
    mail: I('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3 7 9 6 9-6"/>'),
    info: I('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
    warn: I('<path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5M12 18h.01"/>'),
    qr: I('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3h-3zM20 14h1M14 20h1M18 18h3v3h-3z"/>'),
    lock: I('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
    bolt: I('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
    print: I('<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7"/>'),
    copy: I('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    cat: {
      tech: I('<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>', 'stroke-width="1.5"'),
      culture: I('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>', 'stroke-width="1.5"'),
      business: I('<path d="M3 20h18"/><path d="M5 20V12l4-3 4 4 7-7"/><path d="M15 6h5v5"/>', 'stroke-width="1.5"'),
      sports: I('<path d="M3 20 10 6l4 7 2-3 5 10z"/><path d="M8 14h4"/>', 'stroke-width="1.5"'),
      career: I('<path d="M2 9 12 4l10 5-10 5z"/><path d="M6 11v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/><path d="M22 9v6"/>', 'stroke-width="1.5"'),
      science: I('<circle cx="12" cy="12" r="2"/><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/>', 'stroke-width="1.5"'),
      general: I('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>', 'stroke-width="1.5"'),
    },
  };
  const catIcon = (c) => icons.cat[catSlug(c)] || icons.cat.general;

  // ---------- Theme ----------
  const THEME_KEY = 'ce.theme';
  function currentTheme() {
    const saved = (() => { try { return localStorage.getItem(THEME_KEY); } catch { return null; } })();
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    const btn = $('#themeBtn');
    if (btn) { btn.innerHTML = t === 'dark' ? icons.sun : icons.moon; btn.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'); }
  }
  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
    applyTheme(next);
  }

  function header(active) {
    const link = (href, label, key) => `<a href="${href}" ${active === key ? 'aria-current="page"' : ''}>${label}</a>`;
    return `
      <header class="site">
        <div class="container">
          <a class="logo" href="/"><span class="mark">${icons.ticket}</span><span class="word">Campus Events</span></a>
          <nav class="links" aria-label="Primary">
            ${link('/', 'Events', 'events')}
            ${link('/organizer', 'Organizer', 'organizer')}
            <button class="icon-btn" id="themeBtn" type="button" aria-label="Toggle theme"></button>
          </nav>
        </div>
      </header>`;
  }
  function footer() {
    return `<footer class="site"><div class="container"><span>&copy; Campus Events</span><span>Tickets are HMAC-signed and verified once at the door.</span></div></footer>`;
  }
  function mount(active) {
    document.body.insertAdjacentHTML('afterbegin', header(active));
    document.body.insertAdjacentHTML('beforeend', footer());
    applyTheme(currentTheme());
    $('#themeBtn').addEventListener('click', toggleTheme);
    // Surface an ephemeral-storage warning on hosted demos
    fetch('/api/health').then((r) => r.json()).then((h) => {
      if (h && h.ephemeral) {
        $('header.site').insertAdjacentHTML('afterend', '<div class="banner-note">Demo mode: this deployment has no database attached, so registrations reset whenever the server restarts.</div>');
      }
    }).catch(() => {});
  }

  function initials(name) {
    return String(name || '?').split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
  }

  window.CE = { $, $$, esc, fmtDate, fmtTime, fmtFull, fmtDay, fmtClock, monthShort, dayNum, api, toast, capacityClass, catSlug, catIcon, icons, mount, initials };
})();
