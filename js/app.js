// app.js — the conductor: library screen, importing books, the reading
// session, highlights & notes, export to Apple Notes and backups.

import * as db from './db.js';
import { h, icon, iconButton, openSheet, toast, confirmDialog, alertSheet, actionSheet } from './ui.js';
import { openEPUB } from './epub.js';
import { EPUBReader } from './epubreader.js';
import { exportText, shareNote, inkPictures, copyText, sortHighlights, locationLabel, saveFile, makeBackupFile } from './export.js';
import { ReadAloud, unlockSpeech, speechSupported, voicesFor, voicesReady, voiceLabel, voiceQuality } from './speech.js';
import { InkController, inkPreview, PEN_COLORS, PEN_LABELS } from './ink.js';
import { syncIn, syncOutFile, applyWaiting, recordDeletion, lastSyncTime } from './sync.js';

export const VERSION = '1.3.0';
const COLORS = ['yellow', 'green', 'blue', 'pink'];

const app = document.getElementById('app');
const fileInput = document.getElementById('file-input');
const backupInput = document.getElementById('backup-input');
const syncInput = document.getElementById('sync-input');

const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`margins.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`margins.${key}`, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

let library = [];
let counts = new Map();
let inkCounts = new Map();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
let session = null;

// ======================================================================
// Library
// ======================================================================

async function refreshLibrary() {
  library = await db.getAll('books');
  counts = new Map();
  inkCounts = new Map();
  for (const hl of await db.getAll('highlights')) {
    const map = hl.ink ? inkCounts : counts;
    map.set(hl.bookId, (map.get(hl.bookId) || 0) + 1);
  }
  if (!session) renderLibrary();
}

function renderLibrary() {
  const books = [...library].sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt));
  app.replaceChildren(h('div', { class: 'library-view' },
    h('header', { class: 'topbar' },
      h('h1', { class: 'brand' }, 'Margins'),
      h('div', { class: 'topbar-actions' },
        iconButton('more', 'Settings & backup', showSettings),
        iconButton('sync', 'Sync with your other devices', showSync),
        h('button', { class: 'btn-primary', onclick: pickFiles }, icon('plus'), h('span', {}, 'Import')))),
    installBanner(),
    books.length
      ? h('main', { class: 'shelf' }, books.map(bookCard))
      : emptyLibrary()));
}

function installBanner() {
  if (isStandalone() || prefs.get('hideInstall', false)) return null;
  const banner = h('aside', { class: 'install-banner' },
    h('div', { class: 'install-icon' }, icon('offline')),
    h('div', { class: 'install-text' },
      h('strong', {}, 'Read on flights, without internet'),
      h('p', {}, 'In Safari tap ', h('span', { class: 'inline-icon' }, icon('share')), ' Share → “Add to Home Screen”, then always open Margins from its icon.')),
    iconButton('close', 'Dismiss', () => { prefs.set('hideInstall', true); banner.remove(); }));
  return banner;
}

function emptyLibrary() {
  return h('main', { class: 'empty' },
    h('div', { class: 'empty-art' }, icon('books')),
    h('h2', {}, 'Your library is empty'),
    h('p', {}, 'Import EPUB or PDF books from the Files app, iCloud Drive or Downloads. They’re stored on this device, so you can read, highlight and take notes without internet.'),
    h('button', { class: 'btn-primary large', onclick: pickFiles }, icon('plus'), h('span', {}, 'Import books')));
}

function hueFor(text) {
  let n = 0;
  for (const ch of text) n = (n * 31 + ch.codePointAt(0)) % 360;
  return n;
}

function cover(book) {
  const progress = Math.round((book.progress || 0) * 100);
  const art = book.cover
    ? h('img', { src: book.cover, alt: '', loading: 'lazy' })
    : h('div', { class: 'cover-art', style: { '--hue': hueFor(book.title) } },
        h('span', { class: 'cover-title' }, book.title),
        book.author ? h('span', { class: 'cover-author' }, book.author) : null);
  return h('div', { class: 'cover' }, art,
    progress > 0 ? h('div', { class: 'cover-progress', style: { width: `${progress}%` } }) : null);
}

function bookCard(book) {
  const count = counts.get(book.id) || 0;
  const pct = Math.round((book.progress || 0) * 100);
  const inks = inkCounts.get(book.id) || 0;
  const meta = [book.format.toUpperCase(), pct ? `${pct}%` : 'New', count ? plural(count, 'highlight') : null, inks ? plural(inks, 'drawing') : null].filter(Boolean).join(' · ');
  return h('article', { class: 'book' },
    h('button', { class: 'book-open', onclick: () => openBook(book.id), 'aria-label': `Open ${book.title}` },
      cover(book),
      h('div', { class: 'book-title' }, book.title),
      book.author ? h('div', { class: 'book-author' }, book.author) : null),
    h('div', { class: 'book-meta' },
      h('span', {}, meta),
      iconButton('more', `Options for ${book.title}`, () => bookOptions(book), 'small')));
}

function bookOptions(book) {
  actionSheet(book.title, [
    { icon: 'highlighter', label: 'Highlights & Notes', action: async () => showHighlights(book, await db.highlightsFor(book.id), null) },
    { icon: 'share', label: 'Export to Notes', action: () => exportBook(book) },
    { icon: 'trash', label: 'Delete Book', destructive: true, action: () => deleteBook(book) },
  ]);
}

async function deleteBook(book) {
  const ok = await confirmDialog({
    title: 'Delete this book?',
    message: `“${book.title}” and its highlights and notes will be removed from this device. Export them to Notes first if you want to keep them.`,
    confirm: 'Delete Book',
    destructive: true,
  });
  if (!ok) return;
  await db.deleteBook(book.id);
  toast('Book deleted');
  refreshLibrary();
}

async function exportBook(book) {
  const list = await db.highlightsFor(book.id);
  if (!list.length) { toast('This book has no highlights yet'); return; }
  await sendToNotes(book.title, () => notePayload(book, list));
}

/** The text for Apple Notes plus one picture per handwritten note. */
async function notePayload(book, list, pdf = null) {
  let files = [];
  if (list.some((x) => x.ink)) {
    const blob = !pdf && book.format === 'pdf' ? (await db.get('files', book.id))?.blob : null;
    files = await inkPictures(book, list, { pdf, blob }).catch((e) => { console.warn(e); return []; });
  }
  return { text: exportText(book, list, { pictures: files.length > 0 }), files };
}

/**
 * Opens the share sheet with the note (choose "Notes"). Websites can't
 * write into Apple Notes directly; the share sheet is the only door.
 * Safari opens it only straight after a tap, so if preparing pictures took
 * too long, a "Share to Notes" button asks for one more tap.
 */
async function sendToNotes(title, build) {
  let payload;
  let busy = null;
  const slow = setTimeout(() => { busy = toast('Preparing pictures…', { sticky: true }); }, 250);
  try { payload = await build(); } finally { clearTimeout(slow); busy?.close(); }
  const done = (result) => { if (result === 'copied') toast('Copied — paste it into Apple Notes'); };
  const result = await shareNote(title, payload.text, payload.files);
  if (result !== 'needs-tap') { done(result); return; }
  const n = payload.files.length;
  const sheet = openSheet({
    title: 'Ready for Apple Notes',
    subtitle: title,
    body: h('div', { class: 'ready-note' },
      h('p', {}, n ? `Your highlights and ${plural(n, 'handwritten note')} (as pictures) are ready.` : 'Your highlights are ready.'),
      h('button', {
        class: 'btn-primary large',
        onclick: async () => { sheet.close(); done(await shareNote(title, payload.text, payload.files)); },
      }, icon('share'), h('span', {}, 'Share to Notes')),
      h('p', { class: 'hint' }, 'In the share sheet, tap Notes.')),
  });
}

// ======================================================================
// Importing
// ======================================================================

function pickFiles() {
  fileInput.click();
}

fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  importFiles(files);
});

async function importFiles(files) {
  if (!files.length) return;
  const busy = toast(`Importing ${files.length} book${files.length === 1 ? '' : 's'}…`, { sticky: true });
  const failures = [];
  let added = 0;
  for (const file of files) {
    try {
      await importOne(file);
      added++;
    } catch (e) {
      failures.push(`${file.name}: ${e.message}`);
    }
  }
  busy.close();
  navigator.storage?.persist?.().catch(() => {});
  if (added) {
    const waiting = await applyWaiting().catch(() => null);
    if (waiting?.added) toast(`${waiting.added} synced highlight${waiting.added === 1 ? '' : 's'} added from your other devices`);
  }
  await refreshLibrary();
  if (failures.length) alertSheet(added ? 'Some files weren’t imported' : 'Couldn’t import', failures.join('\n\n'));
  else toast(`Added ${added} book${added === 1 ? '' : 's'}`);
}

async function importOne(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const format = ext === 'epub' || file.type === 'application/epub+zip' ? 'epub'
    : ext === 'pdf' || file.type === 'application/pdf' ? 'pdf' : null;
  if (!format) throw new Error('Not an EPUB or PDF file.');

  const data = new Blob([await file.arrayBuffer()], { type: format === 'pdf' ? 'application/pdf' : 'application/epub+zip' });
  let title = file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
  let author = '';
  let coverImage = null;
  let pageCount = 0;

  if (format === 'epub') {
    const epub = await openEPUB(data);
    title = epub.title || title;
    author = epub.author;
    coverImage = await epub.coverThumbnail().catch(() => null);
    epub.close();
  } else {
    const { pdfInfo } = await import('./pdfreader.js');
    const info = await pdfInfo(data);
    title = info.title || title;
    author = info.author;
    coverImage = info.cover;
    pageCount = info.pageCount;
  }

  if (library.some((b) => b.title === title && b.size === file.size && b.format === format)) {
    throw new Error('Already in your library.');
  }

  const id = crypto.randomUUID();
  await db.put('files', { id, blob: data });
  const book = { id, title, author, format, cover: coverImage, size: file.size, pageCount, addedAt: Date.now(), lastOpenedAt: 0, progress: 0, position: {} };
  await db.put('books', book);
  library.push(book);
}

// ======================================================================
// Reading
// ======================================================================

async function openBook(id) {
  if (session) return;
  const book = await db.get('books', id);
  const file = await db.get('files', id);
  if (!book || !file) { toast('This book could not be found.'); return; }
  book.lastOpenedAt = Date.now();
  await db.put('books', book);
  const highlights = await db.highlightsFor(id);
  history.pushState({ reader: id }, '');
  session = new ReaderSession(book, file.blob, highlights);
  try {
    await session.start();
  } catch (e) {
    console.error(e);
    session.showError(e.message || 'Something went wrong.');
  }
}

function leaveReader() {
  if (history.state?.reader) history.back();
  else closeSession();
}

function closeSession() {
  if (!session) return;
  session.close();
  session = null;
  refreshLibrary();
}

window.addEventListener('popstate', () => {
  if (session && !history.state?.reader) closeSession();
});

class ReaderSession {
  constructor(book, blob, highlights) {
    this.book = book;
    this.blob = blob;
    this.highlights = highlights;
    this.reader = null;
    this.build();
  }

  build() {
    const epub = this.book.format === 'epub';
    this.label = h('div', { class: 'foot-label' }, 'Opening…');
    this.prevBtn = iconButton('back', 'Previous chapter', () => this.reader?.go(this.reader.index - 1));
    this.nextBtn = iconButton('forward', 'Next chapter', () => this.reader?.go(this.reader.index + 1));
    this.zoomOutBtn = iconButton('minus', 'Zoom out', () => this.zoom(-0.25));
    this.zoomInBtn = iconButton('plus', 'Zoom in', () => this.zoom(0.25));
    this.body = h('div', { class: 'reader-body' });
    this.bar = this.buildHighlightBar();
    this.player = this.buildPlayer();
    this.penBar = this.buildPenBar();

    this.view = h('div', { class: `reader-view ${epub ? 'is-epub' : 'is-pdf'}` },
      h('header', { class: 'topbar reader-top' },
        iconButton('back', 'Back to Library', leaveReader, 'back-btn'),
        h('div', { class: 'reader-title', title: this.book.title }, this.book.title),
        h('div', { class: 'topbar-actions' },
          epub ? iconButton('list', 'Contents', () => this.showContents()) : null,
          epub ? iconButton('type', 'Text size & typeface', () => this.showTypography()) : null,
          speechSupported() ? (this.speakBtn = iconButton('speaker', 'Read aloud', () => this.togglePlayer())) : null,
          this.penBtn,
          iconButton('highlighter', 'Highlights & Notes', () => showHighlights(this.book, this.highlights, this)))),
      this.body,
      this.player,
      h('footer', { class: 'reader-foot' },
        epub ? this.prevBtn : this.zoomOutBtn,
        this.label,
        epub ? this.nextBtn : this.zoomInBtn),
      this.bar,
      this.penBar);
    app.replaceChildren(this.view);

    this.onKey = (e) => {
      if (document.querySelector('.sheet.open') || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
      if (this.ink?.active && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this.ink.undo(); return; }
      if (this.ink?.active && e.key === 'Escape') { this.togglePen(false); return; }
      if (e.key === 'ArrowRight' && epub) this.reader?.go(this.reader.index + 1);
      else if (e.key === 'ArrowLeft' && epub) this.reader?.go(this.reader.index - 1);
      else if (e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); this.reader?.pageBy(e.shiftKey ? -1 : 1); }
      else if (e.key === 'PageUp') { e.preventDefault(); this.reader?.pageBy(-1); }
    };
    document.addEventListener('keydown', this.onKey);
  }

  async start() {
    const callbacks = {
      onSelection: (has) => this.setSelection(has),
      onTap: (id) => {
        const hl = this.highlights.find((x) => x.id === id);
        if (hl) editHighlight(hl, this);
      },
      onPosition: (pos, progress, label) => this.savePosition(pos, progress, label),
      onChapter: (index, title) => {
        this.readAloud?.invalidate();
        this.label.textContent = title;
        this.prevBtn.disabled = index <= 0;
        this.nextBtn.disabled = index >= this.reader.chapters.length - 1;
      },
      onKey: (e) => this.onKey(e),
    };
    if (this.book.format === 'epub') {
      const epub = await openEPUB(this.blob);
      this.reader = new EPUBReader({
        container: this.body,
        epub,
        highlights: this.highlights,
        callbacks,
        typography: { size: prefs.get('fontSize', 100), family: prefs.get('fontFamily', 'original') },
      });
    } else {
      const { PDFReader } = await import('./pdfreader.js');
      this.reader = new PDFReader({ container: this.body, blob: this.blob, highlights: this.highlights, callbacks });
    }
    await this.reader.open(this.book.position || {});
    this.ink = new InkController({
      reader: this.reader,
      scroller: this.reader.scroller,
      groups: this.highlights,
      bookId: this.book.id,
      onSave: (g) => db.put('highlights', g),
      onDelete: (g) => deleteHighlight(g, this),
    });
    this.ink.color = prefs.get('penColor', 'ink');
    this.ink.finger = prefs.get('penFinger', /iPhone|iPod|Android/.test(navigator.userAgent));
    this.updatePenBar();
    this.ink.renderAll();
    this.penBtn.disabled = false;
  }

  // ---- Handwriting ----

  buildPenBar() {
    this.penBtn = iconButton('pencil', 'Write with Apple Pencil', () => this.togglePen());
    this.penBtn.disabled = true;
    this.penDots = PEN_COLORS.map((c) => h('button', {
      class: `pen-dot pen-bg-${c}`,
      role: 'radio',
      'aria-label': `${PEN_LABELS[c]} pen`,
      onclick: () => this.setPen(c),
    }));
    this.eraserBtn = iconButton('eraser', 'Eraser', () => this.setEraser());
    this.fingerBtn = 'ontouchstart' in window ? iconButton('hand', 'Draw with your finger too', () => this.toggleFinger()) : null;
    const bar = h('div', { class: 'pen-bar', role: 'toolbar', 'aria-label': 'Handwriting tools', hidden: true },
      h('div', { class: 'pen-dots', role: 'radiogroup', 'aria-label': 'Pen colour' }, this.penDots),
      h('span', { class: 'hl-sep', 'aria-hidden': 'true' }),
      this.eraserBtn,
      iconButton('undo', 'Undo', () => { if (!this.ink?.undo()) toast('Nothing to undo'); }),
      this.fingerBtn,
      h('button', { class: 'pen-done', onclick: () => this.togglePen(false) }, 'Done'));
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    return bar;
  }

  updatePenBar() {
    if (!this.ink) return;
    const pen = this.ink.tool === 'pen';
    this.penDots.forEach((b, i) => b.setAttribute('aria-checked', String(pen && PEN_COLORS[i] === this.ink.color)));
    this.eraserBtn.classList.toggle('active', !pen);
    this.eraserBtn.setAttribute('aria-pressed', String(!pen));
    if (this.fingerBtn) {
      this.fingerBtn.classList.toggle('active', this.ink.finger);
      this.fingerBtn.setAttribute('aria-pressed', String(this.ink.finger));
    }
  }

  setPen(color) {
    this.ink.setTool('pen');
    this.ink.color = color;
    prefs.set('penColor', color);
    this.updatePenBar();
  }

  setEraser() {
    this.ink.setTool(this.ink.tool === 'eraser' ? 'pen' : 'eraser');
    this.updatePenBar();
  }

  toggleFinger() {
    this.ink.finger = !this.ink.finger;
    prefs.set('penFinger', this.ink.finger);
    this.updatePenBar();
    toast(this.ink.finger ? 'Your finger draws too — scroll with two fingers' : 'Only Apple Pencil draws — your finger scrolls');
  }

  togglePen(force) {
    if (!this.ink) return;
    const on = force ?? !this.ink.active;
    this.ink.setActive(on);
    if (on) {
      this.ink.setTool('pen');
      document.getSelection()?.removeAllRanges();
      this.reader?.doc?.getSelection?.()?.removeAllRanges();
      this.bar.classList.remove('show');
      if (!prefs.get('penTipSeen', false)) {
        prefs.set('penTipSeen', true);
        toast(this.ink.finger ? 'Draw with your finger. Scroll with two fingers.' : 'Write with Apple Pencil. Your finger still scrolls the page.');
      }
    }
    this.view.classList.toggle('pen-on', on);
    this.penBar.hidden = !on;
    this.penBtn.classList.toggle('active', on);
    this.penBtn.setAttribute('aria-pressed', String(on));
    this.updatePenBar();
  }

  buildHighlightBar() {
    const bar = h('div', { class: 'hl-bar', role: 'toolbar', 'aria-label': 'Highlight the selected text' },
      COLORS.map((c) => h('button', { class: `hl-dot dot-${c}`, 'aria-label': `Highlight in ${c}`, onclick: () => this.addHighlight(c, false) })),
      h('span', { class: 'hl-sep', 'aria-hidden': 'true' }),
      h('button', { class: 'hl-note', onclick: () => this.addHighlight(prefs.get('lastColor', 'yellow'), true) },
        icon('note'), h('span', {}, 'Note')));
    // Keep the text selection alive when the bar is pressed
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    return bar;
  }

  setSelection(has) {
    clearTimeout(this.hideTimer);
    if (has) this.bar.classList.add('show');
    else this.hideTimer = setTimeout(() => this.bar.classList.remove('show'), 250);
  }

  async addHighlight(color, withNote) {
    const data = this.reader?.captureSelection();
    this.bar.classList.remove('show');
    if (!data) { toast('Select some text first'); return; }
    prefs.set('lastColor', color);
    const now = Date.now();
    const hl = { id: crypto.randomUUID(), bookId: this.book.id, color, note: '', createdAt: now, updatedAt: now, ...data };
    this.highlights.push(hl);
    this.reader.paint(hl);
    this.readAloud?.refresh();
    await db.put('highlights', hl);
    if (withNote) editHighlight(hl, this);
  }

  savePosition(pos, progress, label) {
    if (label) this.label.textContent = label;
    this.book.position = pos;
    this.book.progress = progress;
    this.book.positionUpdatedAt = Date.now();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => db.put('books', this.book), 600);
  }

  zoom(delta) {
    if (!this.reader?.setZoom) return;
    const z = this.reader.setZoom(this.reader.zoom + delta);
    this.zoomOutBtn.disabled = z <= 1;
    this.zoomInBtn.disabled = z >= 3;
    toast(`Zoom ${Math.round(z * 100)}%`);
  }

  showContents() {
    const chapters = this.reader?.chapters;
    if (!chapters) return;
    const hasToc = chapters.some((c) => c.isTocEntry);
    let current = this.reader.index;
    if (hasToc) while (current > 0 && !chapters[current].isTocEntry) current--;
    const items = chapters.map((c, i) => ((!hasToc || c.isTocEntry)
      ? h('button', {
        class: `toc-item${i === current ? ' current' : ''}`,
        onclick: () => { sheet.close(); this.reader.go(i); },
      }, h('span', {}, c.title), i === current ? icon('check') : null)
      : null));
    const sheet = openSheet({ title: 'Contents', subtitle: this.book.title, body: h('nav', { class: 'toc' }, items) });
    requestAnimationFrame(() => sheet.panel.querySelector('.toc-item.current')?.scrollIntoView({ block: 'center' }));
  }

  showTypography() {
    let size = prefs.get('fontSize', 100);
    let family = prefs.get('fontFamily', 'original');
    const value = h('span', { class: 'size-value' }, `${size}%`);
    const apply = () => {
      prefs.set('fontSize', size);
      prefs.set('fontFamily', family);
      value.textContent = `${size}%`;
      this.reader?.setTypography({ size, family });
    };
    const families = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Typeface' },
      [['original', 'Book'], ['serif', 'Serif'], ['sans', 'Sans']].map(([key, label]) => {
        const b = h('button', {
          role: 'radio',
          class: `seg seg-${key}`,
          'aria-checked': String(family === key),
          onclick: () => {
            family = key;
            families.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
            apply();
          },
        }, label);
        return b;
      }));
    openSheet({
      title: 'Text',
      body: h('div', { class: 'typo' },
        h('div', { class: 'field-label' }, 'Size'),
        h('div', { class: 'size-row' },
          h('button', { class: 'size-btn', 'aria-label': 'Smaller text', onclick: () => { size = Math.max(70, size - 10); apply(); } }, h('span', { class: 'a-small' }, 'A')),
          value,
          h('button', { class: 'size-btn', 'aria-label': 'Larger text', onclick: () => { size = Math.min(200, size + 10); apply(); } }, h('span', { class: 'a-large' }, 'A'))),
        h('div', { class: 'field-label' }, 'Typeface'),
        families),
    });
  }

  showError(message) {
    this.label.textContent = '';
    this.body.replaceChildren(h('div', { class: 'reader-error' },
      h('h2', {}, 'Can’t open this book'),
      h('p', {}, message),
      h('button', { class: 'btn-secondary', onclick: leaveReader }, 'Back to Library')));
  }

  // ---- Read aloud ----

  get speechLang() {
    return this.reader?.epub?.language || this.reader?.language || navigator.language || 'en';
  }

  get voiceKey() { return `voice.${this.speechLang.toLowerCase().split(/[-_]/)[0]}`; }

  buildPlayer() {
    this.playBtn = h('button', { class: 'ra-play', 'aria-label': 'Play', onclick: () => { unlockSpeech(); this.readAloud?.toggle(); } }, icon('play'));
    this.rateBtn = h('button', { class: 'ra-chip', 'aria-label': 'Reading speed', onclick: () => this.cycleRate() }, `${prefs.get('speechRate', 1)}×`);
    this.voiceName = h('span', { class: 'ra-voice-name' }, 'Voice');
    const voiceBtn = h('button', { class: 'ra-chip ra-voice', 'aria-label': 'Choose voice', onclick: () => this.showVoices() }, this.voiceName);
    return h('div', { class: 'ra-bar', role: 'toolbar', 'aria-label': 'Read aloud', hidden: true },
      voiceBtn,
      h('div', { class: 'ra-controls' },
        iconButton('skipBack', 'Previous sentence', () => this.readAloud?.skip(-1)),
        this.playBtn,
        iconButton('skipFwd', 'Next sentence', () => this.readAloud?.skip(1))),
      h('div', { class: 'ra-right' },
        this.rateBtn,
        iconButton('close', 'Stop reading aloud', () => this.closePlayer(), 'small')));
  }

  async togglePlayer() {
    if (!this.player.hidden) { this.closePlayer(); return; }
    if (!this.reader?.speechSection) return;
    unlockSpeech();
    this.player.hidden = false;
    this.view.classList.add('ra-open');
    this.speakBtn?.classList.add('active');
    if (!this.readAloud) {
      this.readAloud = new ReadAloud({
        reader: this.reader,
        lang: this.speechLang,
        getVoiceURI: () => prefs.get(this.voiceKey, null),
        rate: prefs.get('speechRate', 1),
        onState: (st) => {
          this.playBtn.replaceChildren(icon(st.playing ? 'pause' : 'play'));
          this.playBtn.setAttribute('aria-label', st.playing ? 'Pause' : 'Play');
          if (st.finished) toast('End of the book');
        },
      });
    }
    this.readAloud.setMediaControls(this.book.title, this.book.author);
    await voicesReady();
    this.updateVoiceName();
    this.readAloud.play();
  }

  closePlayer() {
    this.readAloud?.pause();
    this.reader?.speechClear?.();
    if (this.readAloud) this.readAloud.units = null;
    this.player.hidden = true;
    this.view.classList.remove('ra-open');
    this.speakBtn?.classList.remove('active');
  }

  updateVoiceName() {
    const v = this.readAloud?.voice;
    this.voiceName.textContent = v ? voiceLabel(v).name : 'Voice';
  }

  cycleRate() {
    const rates = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
    const now = prefs.get('speechRate', 1);
    const next = rates[(rates.indexOf(now) + 1) % rates.length] ?? 1;
    prefs.set('speechRate', next);
    this.rateBtn.textContent = `${next}×`;
    this.readAloud?.setRate(next);
  }

  async showVoices() {
    await voicesReady();
    const voices = voicesFor(this.speechLang);
    const current = this.readAloud?.voice?.voiceURI;
    const good = voices.some((v) => voiceQuality(v) >= 2);
    const tip = h('p', { class: 'hint ra-tip' }, good
      ? 'Premium and Enhanced voices sound the most natural.'
      : 'Safari only lets web apps like Margins use Apple’s standard voices, so voices you download in Settings (Enhanced, Premium, or newer ones like Jamie) can’t appear here.');
    const seen = {};
    const list = h('div', { class: 'ra-voices' }, voices.map((v) => {
      const { name: base, tag } = voiceLabel(v);
      seen[base] = (seen[base] || 0) + 1;
      const name = seen[base] > 1 ? `${base} ${seen[base]}` : base;
      return h('button', {
        class: `toc-item${v.voiceURI === current ? ' current' : ''}`,
        onclick: () => {
          prefs.set(this.voiceKey, v.voiceURI);
          list.querySelectorAll('.toc-item').forEach((b) => b.classList.remove('current'));
          list.querySelectorAll('.toc-item .icon').forEach((i) => i.remove());
          const btn = list.children[voices.indexOf(v)];
          btn.classList.add('current');
          btn.append(icon('check'));
          this.updateVoiceName();
          if (this.readAloud?.playing) this.readAloud.restartSentence();
          else {
            const u = new SpeechSynthesisUtterance(this.book.title || name);
            u.voice = v; u.lang = v.lang; u.rate = prefs.get('speechRate', 1);
            speechSynthesis.cancel(); speechSynthesis.speak(u);
          }
        },
      },
      h('span', { class: 'ra-voice-row' },
        h('span', {}, name),
        h('span', { class: 'ra-voice-meta' }, [tag, v.lang].filter(Boolean).join(' · '))),
      v.voiceURI === current ? icon('check') : null);
    }));
    openSheet({
      title: 'Voice',
      subtitle: 'Tap a voice to hear it',
      body: h('div', {}, good ? null : tip, voices.length ? list : h('p', { class: 'hint' }, 'No voices found on this device.'), good ? tip : null),
    });
  }

  close() {
    this.ink?.destroy();
    this.readAloud?.destroy();
    clearTimeout(this.saveTimer);
    clearTimeout(this.hideTimer);
    document.removeEventListener('keydown', this.onKey);
    db.put('books', this.book);
    try { this.reader?.destroy(); } catch (e) { console.warn(e); }
  }
}

// ======================================================================
// Highlights & notes
// ======================================================================

async function deleteHighlight(hl, owner, list) {
  hl.deleted = true;
  await db.del('highlights', hl.id);
  const book = owner?.book || library.find((b) => b.id === hl.bookId) || await db.get('books', hl.bookId);
  await recordDeletion(hl, book).catch(() => {});
  const arrays = [owner?.highlights, list].filter(Boolean);
  for (const arr of arrays) {
    const i = arr.indexOf(hl);
    if (i >= 0) arr.splice(i, 1);
  }
  owner?.reader?.unpaint(hl);
  owner?.readAloud?.refresh();
}

function editHighlight(hl, owner, { list, onChange } = {}) {
  if (hl.ink) { showInk(hl, owner, { list, onChange }); return; }
  const quote = h('blockquote', { class: `editor-quote q-${hl.color}` }, hl.text);
  const note = h('textarea', { class: 'note-input', placeholder: 'Add your thoughts…', rows: '5', 'aria-label': 'Note' });
  note.value = hl.note || '';

  let timer;
  let savedNote = hl.note || '';
  let savedColor = hl.color;
  const save = () => {
    clearTimeout(timer);
    if (hl.deleted) return;
    hl.note = note.value;
    if (hl.note === savedNote && hl.color === savedColor) return; // nothing changed
    savedNote = hl.note;
    savedColor = hl.color;
    hl.updatedAt = Date.now();
    db.put('highlights', hl);
    onChange?.();
  };
  note.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(save, 400); });

  const colorRow = h('div', { class: 'color-row', role: 'radiogroup', 'aria-label': 'Highlight colour' },
    COLORS.map((c) => {
      const b = h('button', {
        class: `color-choice dot-${c}`,
        role: 'radio',
        'aria-checked': String(hl.color === c),
        'aria-label': c,
        onclick: () => {
          hl.color = c;
          prefs.set('lastColor', c);
          colorRow.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
          quote.className = `editor-quote q-${c}`;
          owner?.reader?.repaint(hl);
          save();
        },
      }, icon('check'));
      return b;
    }));

  const sheet = openSheet({
    title: 'Highlight',
    subtitle: locationLabel(hl),
    closeLabel: 'Done',
    body: h('div', { class: 'editor' },
      quote,
      h('label', { class: 'field-label', for: 'note-field' }, 'Note'),
      note,
      h('div', { class: 'field-label' }, 'Colour'),
      colorRow,
      h('button', {
        class: 'btn-danger-text',
        onclick: async () => {
          const ok = await confirmDialog({ title: 'Delete this highlight?', message: 'Its note will be deleted too.', confirm: 'Delete Highlight', destructive: true });
          if (!ok) return;
          await deleteHighlight(hl, owner, list);
          sheet.close();
          onChange?.();
          toast('Highlight deleted');
        },
      }, icon('trash'), h('span', {}, 'Delete highlight'))),
    onClose: save,
  });
  note.id = 'note-field';
  if (!hl.note && !matchMedia('(pointer: coarse)').matches) setTimeout(() => note.focus(), 320);
}

/** A handwritten note: its picture, a place to type a note, and Delete. */
function showInk(g, owner, { list, onChange } = {}) {
  const note = h('textarea', { class: 'note-input', placeholder: 'Add a typed note (optional)…', rows: '3', 'aria-label': 'Note' });
  note.value = g.note || '';
  let saved = g.note || '';
  let timer;
  const save = () => {
    clearTimeout(timer);
    if (g.deleted || note.value === saved) return;
    g.note = saved = note.value;
    g.updatedAt = Date.now();
    db.put('highlights', g);
    onChange?.();
  };
  note.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(save, 400); });
  const sheet = openSheet({
    title: 'Handwritten note',
    subtitle: locationLabel(g),
    closeLabel: 'Done',
    body: h('div', { class: 'editor' },
      h('div', { class: 'ink-card' }, inkPreview(g, { maxHeight: 220 })),
      g.text ? h('p', { class: 'ink-near' }, 'Next to: ', h('span', {}, `“${g.text}”`)) : null,
      owner ? h('button', { class: 'btn-secondary', onclick: () => { sheet.close(); owner.reader.jumpTo(g); } }, icon('forward'), h('span', {}, 'Show on the page')) : null,
      h('label', { class: 'field-label', for: 'note-field' }, 'Note'),
      note,
      h('button', {
        class: 'btn-danger-text',
        onclick: async () => {
          const ok = await confirmDialog({ title: 'Delete this handwritten note?', message: 'The drawing will be removed from the page.', confirm: 'Delete', destructive: true });
          if (!ok) return;
          await deleteHighlight(g, owner, list);
          owner?.ink?.renderAll();
          sheet.close();
          onChange?.();
          toast('Handwritten note deleted');
        },
      }, icon('trash'), h('span', {}, 'Delete handwritten note'))),
    onClose: save,
  });
  note.id = 'note-field';
}

function showHighlights(book, list, owner) {
  const listEl = h('div', { class: 'hl-list' });
  const count = h('span', { class: 'hl-count' });
  const copyBtn = h('button', {
    class: 'btn-secondary small',
    onclick: async () => { await copyText(exportText(book, list)); toast('Copied to clipboard'); },
  }, icon('copy'), h('span', {}, 'Copy'));
  // Pictures are made ahead of time, so the share sheet opens at once on tap
  let ready = null;
  let prepTimer = null;
  const prepare = () => {
    clearTimeout(prepTimer);
    ready = null;
    if (!list.some((x) => x.ink)) return;
    prepTimer = setTimeout(() => { ready = notePayload(book, list, owner?.reader?.pdf || null); ready.catch(() => {}); }, 300);
  };
  const exportBtn = h('button', {
    class: 'btn-primary small',
    onclick: () => sendToNotes(book.title, () => ready || notePayload(book, list, owner?.reader?.pdf || null)),
  }, icon('share'), h('span', {}, 'Export to Notes'));

  const render = () => {
    prepare();
    const items = sortHighlights(list);
    const inks = items.filter((x) => x.ink).length;
    count.textContent = [items.length - inks ? plural(items.length - inks, 'highlight') : '', inks ? plural(inks, 'handwritten note') : ''].filter(Boolean).join(' · ');
    copyBtn.disabled = exportBtn.disabled = !items.length;
    if (!items.length) {
      listEl.replaceChildren(h('div', { class: 'empty-small' },
        icon('highlighter'),
        h('p', {}, 'No highlights yet'),
        h('p', { class: 'muted' }, 'Select text while reading, then tap a colour — or tap the pencil to write on the page.')));
      return;
    }
    listEl.replaceChildren(...items.map((hl) => h('div', { class: `hl-item q-${hl.color}` },
      h('button', {
        class: 'hl-item-main',
        onclick: () => {
          if (owner) { sheet.close(); owner.reader.jumpTo(hl); }
          else editHighlight(hl, null, { list, onChange: render });
        },
      },
        h('div', { class: 'hl-item-loc' }, hl.ink ? `${locationLabel(hl)} · Handwritten` : locationLabel(hl)),
        hl.ink ? h('div', { class: 'ink-card small' }, inkPreview(hl)) : h('div', { class: 'hl-item-text' }, hl.text),
        hl.ink && hl.text ? h('div', { class: 'ink-near' }, 'Next to: ', h('span', {}, `“${hl.text}”`)) : null,
        hl.note ? h('div', { class: 'hl-item-note' }, icon('note'), h('span', {}, hl.note)) : null),
      iconButton(hl.ink ? 'more' : 'note', hl.ink ? 'Options' : 'Edit note', () => editHighlight(hl, owner, { list, onChange: render }), 'hl-item-edit'))));
  };

  const sheet = openSheet({
    title: 'Highlights & Notes',
    subtitle: book.title,
    body: h('div', {}, h('div', { class: 'hl-toolbar' }, count, h('div', { class: 'row' }, copyBtn, exportBtn)), listEl),
    onClose: () => { if (!owner) refreshLibrary(); },
  });
  render();
}

// ======================================================================
// Settings, backup & restore
// ======================================================================

// ======================================================================
// Sync between devices (one file in iCloud Drive)
// ======================================================================

let syncSheetStatus = null;

function describeStats(s) {
  const parts = [];
  if (s.added) parts.push(`${s.added} new`);
  if (s.updated) parts.push(`${s.updated} updated`);
  if (s.removed) parts.push(`${s.removed} removed`);
  if (s.positions) parts.push(`${s.positions} reading position${s.positions === 1 ? '' : 's'}`);
  let text = parts.length ? `Brought in: ${parts.join(', ')}.` : 'Already up to date.';
  if (s.waiting) text += ` ${s.waiting} highlight${s.waiting === 1 ? ' is' : 's are'} waiting for books not on this device yet — import those books and they’ll appear.`;
  return text;
}

async function showSync() {
  const last = await lastSyncTime();
  const when = last
    ? new Date(last).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : 'never';

  const status1 = h('p', { class: 'sync-status', role: 'status' });
  const status2 = h('p', { class: 'sync-status', role: 'status' });
  syncSheetStatus = status1;

  const step2 = h('div', { class: 'sync-step' },
    h('div', { class: 'sync-num' }, '2'),
    h('div', { class: 'sync-content' },
      h('h3', {}, 'Save changes'),
      h('p', {}, 'Tap Save, choose “Save to Files”, pick iCloud Drive → a folder such as “Margins”, and Save. If asked, choose Replace.'),
      h('button', {
        class: 'btn-primary',
        onclick: async () => {
          try {
            const file = await syncOutFile();
            const result = await saveFile(file);
            if (result !== 'cancelled') {
              status2.textContent = result === 'downloaded' ? '✓ Saved to your Downloads folder.' : '✓ Sync file ready — make sure you saved it to iCloud Drive.';
              step2.classList.add('done');
            }
          } catch (e) {
            status2.textContent = `Couldn’t save: ${e.message}`;
          }
        },
      }, icon('upload'), h('span', {}, 'Save sync file')),
      status2));

  const step1 = h('div', { class: 'sync-step' },
    h('div', { class: 'sync-num' }, '1'),
    h('div', { class: 'sync-content' },
      h('h3', {}, 'Get changes'),
      h('p', {}, 'Choose “margins-sync.json” from iCloud Drive. On your very first sync, skip this step.'),
      h('button', { class: 'btn-secondary', onclick: () => syncInput.click() }, icon('download'), h('span', {}, 'Choose sync file')),
      status1));

  openSheet({
    title: 'Sync',
    subtitle: `Last synced on this device: ${when}`,
    body: h('div', { class: 'sync' },
      h('p', { class: 'sync-intro' }, 'Keeps highlights, notes and where you stopped reading the same on your iPad, iPhone and Mac — using one file in your iCloud Drive. Do both steps on each device, one device after the other.'),
      step1,
      step2,
      h('p', { class: 'hint' }, 'Books themselves don’t sync — import each book on every device where you want to read it.')),
    onClose: () => { syncSheetStatus = null; },
  });
}

syncInput.addEventListener('change', async () => {
  const file = syncInput.files[0];
  syncInput.value = '';
  if (!file) return;
  const status = syncSheetStatus;
  if (status) status.textContent = 'Syncing…';
  try {
    const stats = await syncIn(file);
    const text = `✓ ${describeStats(stats)} Now do step 2.`;
    if (status) {
      status.textContent = text;
      status.closest('.sync-step')?.classList.add('done');
    } else toast(text);
    await refreshLibrary();
  } catch (e) {
    if (status) status.textContent = e.message;
    else alertSheet('Couldn’t sync', e.message);
  }
});

async function showSettings() {
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const mb = (bytes) => `${(bytes / 1048576).toFixed(bytes > 1048576 * 10 ? 0 : 1)} MB`;
  const all = await db.getAll('highlights');

  const sheet = openSheet({
    title: 'Margins',
    subtitle: `Version ${VERSION}`,
    body: h('div', { class: 'settings' },
      h('section', {},
        h('h3', {}, 'Highlights'),
        h('div', { class: 'action-list' },
          h('button', { class: 'action-item', onclick: () => { sheet.close(); showSync(); } }, icon('sync'), h('span', {}, 'Sync with your other devices')),
          h('button', { class: 'action-item', disabled: !all.length, onclick: () => { sheet.close(); exportAll(); } }, icon('share'), h('span', {}, 'Export all highlights to Notes')),
          h('button', { class: 'action-item', onclick: () => { sheet.close(); backup(); } }, icon('download'), h('span', {}, 'Back up highlights & notes')),
          h('button', { class: 'action-item', onclick: () => { sheet.close(); backupInput.click(); } }, icon('upload'), h('span', {}, 'Restore from a backup'))),
        h('p', { class: 'hint' }, 'Your books and highlights live only on this device. Sync keeps your devices in step through one file in iCloud Drive; a backup is a dated copy you keep for safety.')),
      h('section', {},
        h('h3', {}, 'Offline & storage'),
        h('p', {}, isStandalone()
          ? 'Installed on your Home Screen — Margins works without internet.'
          : 'To read offline, open this page in Safari, tap Share → “Add to Home Screen”, and open Margins from its icon.'),
        estimate ? h('p', { class: 'muted' }, `${mb(estimate.usage || 0)} used on this device${persisted ? ' · protected from automatic clean-up' : ''}.`) : null),
      h('section', {},
        h('h3', {}, 'Good to know'),
        h('p', { class: 'muted' }, 'Books bought in Apple Books, Kindle or Kobo are copy-protected (DRM) and can’t be opened here. DRM-free EPUBs and any normal PDF work. PDF rendering by Mozilla PDF.js.'))),
  });
}

async function exportAll() {
  const books = await db.getAll('books');
  const all = await db.getAll('highlights');
  const withNotes = books.map((book) => [book, all.filter((hl) => hl.bookId === book.id)]).filter(([, list]) => list.length);
  if (!withNotes.length) { toast('No highlights yet'); return; }
  await sendToNotes('Margins highlights', async () => {
    const parts = [];
    const files = [];
    for (const [book, list] of withNotes) {
      const p = await notePayload(book, list);
      parts.push(p.text);
      files.push(...p.files);
    }
    return { text: parts.join('\n\n\n'), files };
  });
}

async function backup() {
  const file = makeBackupFile(await db.getAll('books'), await db.getAll('highlights'));
  const result = await saveFile(file);
  if (result === 'downloaded') toast('Backup downloaded');
}

backupInput.addEventListener('change', async () => {
  const file = backupInput.files[0];
  backupInput.value = '';
  if (file) await restoreBackup(file);
});

async function restoreBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  if (data?.app !== 'margins' || !Array.isArray(data.highlights)) {
    alertSheet('Not a Margins backup', 'Please choose a file named like “margins-backup-2026-10-18.json”.');
    return;
  }
  const books = await db.getAll('books');
  const existing = new Set((await db.getAll('highlights')).map((x) => x.id));
  const match = new Map();
  for (const b of data.books || []) {
    const local = books.find((x) => x.id === b.id)
      || books.find((x) => x.title === b.title && x.format === b.format && x.size === b.size)
      || books.find((x) => x.title === b.title && x.format === b.format);
    if (local) match.set(b.id, local.id);
  }
  let added = 0;
  let missing = 0;
  for (const hl of data.highlights) {
    const bookId = match.get(hl.bookId);
    if (!bookId) { missing++; continue; }
    if (existing.has(hl.id)) continue;
    await db.put('highlights', { ...hl, bookId });
    added++;
  }
  await refreshLibrary();
  alertSheet('Backup restored',
    `${added} highlight${added === 1 ? '' : 's'} added.` +
    (missing ? `\n\n${missing} belong to books that aren’t in this library yet. Import those books, then restore the backup again.` : ''));
}

// ======================================================================
// Start
// ======================================================================

if ('serviceWorker' in navigator) {
  // When a new version of Margins has been downloaded, switch to it once.
  const hadVersion = !!navigator.serviceWorker.controller;
  let switching = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadVersion || switching) return;
    switching = true;
    location.reload();
  });
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      // A Home Screen app is often resumed, not restarted: check for updates each time it comes back.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && navigator.onLine) reg.update().catch(() => {});
      });
      return navigator.serviceWorker.ready;
    })
    .then(() => {
      if (!prefs.get('offlineReady', false)) {
        prefs.set('offlineReady', true);
        toast('Margins is ready to work offline');
      }
    })
    .catch((e) => console.warn('Offline support unavailable', e));
}

history.replaceState(null, '');
refreshLibrary();
