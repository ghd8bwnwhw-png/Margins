// ui.js — small building blocks: icons, buttons, bottom sheets, toasts.

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  forward: '<path d="M9 18l6-6-6-6"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1" fill="currentColor" stroke="none"/>',
  type: '<path d="M3 18 7.5 6 12 18M4.7 14h5.6"/><path d="M14.5 11.2c.6-.8 1.5-1.2 2.6-1.2 1.8 0 2.9 1 2.9 2.8V18M20 14.4c-3.6-.2-5.7.6-5.7 2.1 0 1 .8 1.6 2 1.6 1.7 0 3.7-1.1 3.7-3.7"/>',
  highlighter: '<path d="M14.5 4.5l5 5-8.6 8.6H6v-4.9z"/><path d="M12 7l5 5"/><path d="M4 21h9"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/>',
  more: '<circle cx="5.5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  note: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V5M7 10l5-5 5 5M5 20h14"/>',
  books: '<path d="M5 19.5V5.5a1 1 0 0 1 1-1h2.5a1 1 0 0 1 1 1v14M9.5 19.5V8a1 1 0 0 1 1-1H13a1 1 0 0 1 1 1v11.5"/><path d="M15 8.4l2.4-.7a1 1 0 0 1 1.2.7l2.8 10.3a1 1 0 0 1-.7 1.2l-2.4.6"/><path d="M3 20.5h18"/>',
  offline: '<path d="M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1" fill="currentColor" stroke="none"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  speaker: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  pause: '<rect x="6.5" y="5.5" width="3.8" height="13" rx="1" fill="currentColor" stroke="none"/><rect x="13.7" y="5.5" width="3.8" height="13" rx="1" fill="currentColor" stroke="none"/>',
  skipBack: '<path d="M18 6.5v11l-8-5.5z"/><path d="M6.5 6v12"/>',
  skipFwd: '<path d="M6 6.5v11l8-5.5z"/><path d="M17.5 6v12"/>',
  pencil: '<path d="M15.2 4.8a2.1 2.1 0 0 1 3 3L8.4 17.6 4.5 19.5l1.9-3.9z"/><path d="M13.5 6.5l3 3"/><path d="M14 20h6"/>',
  eraser: '<path d="M8.5 19.5 4 15a1.8 1.8 0 0 1 0-2.5l8-8a1.8 1.8 0 0 1 2.5 0l5 5a1.8 1.8 0 0 1 0 2.5l-7.5 7.5z"/><path d="M8.5 19.5H20M9 8l7 7"/>',
  undo: '<path d="M9 14 4.5 9.5 9 5"/><path d="M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-3"/>',
  hand: '<path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11.5v-6a1.5 1.5 0 0 1 3 0v6M14 11.5v-4a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-.6a5 5 0 0 1-4-2l-2.6-3.6a1.5 1.5 0 0 1 2.3-1.9L8 15"/>',
  sync: '<path d="M19.5 10A7.5 7.5 0 0 0 6.2 6.6L4.5 8.3"/><path d="M4.5 4.5v3.8h3.8"/><path d="M4.5 14a7.5 7.5 0 0 0 13.3 3.4l1.7-1.7"/><path d="M19.5 19.5v-3.8h-3.8"/>',
};

export function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

/** Tiny helper to build elements: h('button', {class: 'x', onclick}, 'Label') */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, String(v));
        else el.style[prop] = v;
      }
    }
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export function iconButton(name, label, onclick, extraClass = '') {
  return h('button', { class: `icon-btn ${extraClass}`.trim(), 'aria-label': label, title: label, onclick }, icon(name));
}

// ---------- Bottom sheets ----------

const openSheets = [];

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openSheets.length) openSheets[openSheets.length - 1].close();
});

export function openSheet({ title, subtitle, body, actions = [], onClose, closeLabel = 'Close' }) {
  const backdrop = h('div', { class: 'sheet-backdrop' });
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
    h('div', { class: 'sheet-head' },
      h('button', { class: 'btn-text', onclick: () => api.close() }, closeLabel),
      h('div', { class: 'sheet-title' }, h('h2', {}, title), subtitle ? h('p', {}, subtitle) : null),
      h('div', { class: 'sheet-actions' }, ...actions)),
    h('div', { class: 'sheet-body' }, body));
  document.body.append(backdrop, panel);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    backdrop.classList.add('open');
    panel.classList.add('open');
  }));
  backdrop.addEventListener('click', () => api.close());

  let closed = false;
  const api = {
    panel,
    close() {
      if (closed) return;
      closed = true;
      openSheets.splice(openSheets.indexOf(api), 1);
      backdrop.classList.remove('open');
      panel.classList.remove('open');
      setTimeout(() => { backdrop.remove(); panel.remove(); }, 280);
      onClose?.();
    },
  };
  openSheets.push(api);
  return api;
}

export function confirmDialog({ title, message, confirm = 'OK', destructive = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value) => { if (!answered) { answered = true; resolve(value); } sheet.close(); };
    const sheet = openSheet({
      title,
      closeLabel: 'Cancel',
      body: h('div', { class: 'confirm' },
        message ? h('p', {}, message) : null,
        h('button', { class: destructive ? 'btn-danger wide' : 'btn-primary wide', onclick: () => answer(true) }, confirm)),
      onClose: () => { if (!answered) { answered = true; resolve(false); } },
    });
  });
}

export function alertSheet(title, message) {
  const sheet = openSheet({
    title,
    body: h('div', { class: 'confirm' },
      h('p', { class: 'pre' }, message),
      h('button', { class: 'btn-primary wide', onclick: () => sheet.close() }, 'OK')),
  });
}

export function actionSheet(title, items) {
  const sheet = openSheet({
    title,
    body: h('div', { class: 'action-list' },
      items.map((item) => h('button', {
        class: `action-item${item.destructive ? ' destructive' : ''}`,
        onclick: () => { sheet.close(); item.action(); },
      }, icon(item.icon), h('span', {}, item.label)))),
  });
}

// ---------- Toasts ----------

let toastHost = null;

export function toast(message, { sticky = false } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: 'toast' }, message);
  toastHost.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const close = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  };
  if (!sticky) setTimeout(close, 2600);
  return { close };
}
