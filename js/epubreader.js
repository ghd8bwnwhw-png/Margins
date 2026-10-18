// epubreader.js — shows one EPUB chapter at a time in a frame that is
// as tall as the chapter, inside a smoothly scrolling container.

import { h, icon } from './ui.js';
import * as HL from './highlighter.js';
import { resolvePath, dirOf } from './epub.js';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

const BASE_CSS = `
  html { overflow: hidden !important; height: auto !important; -webkit-text-size-adjust: 100%; }
  html, body { background: transparent !important; min-height: 0 !important; }
  body { height: auto !important; max-width: 38em; margin: 0 auto !important;
         padding: 28px 22px 48px !important; line-height: 1.6; overflow-wrap: break-word;
         box-sizing: border-box; }
  img, svg, video { max-width: 100% !important; height: auto !important; }
  a { color: #2f5d50; }
  mark.rh { color: inherit !important; border-radius: 3px; cursor: pointer; padding: 0 0.04em;
            -webkit-box-decoration-break: clone; box-decoration-break: clone; }
  mark.rh-yellow { background-color: rgba(255, 204, 0, 0.42) !important; }
  mark.rh-green  { background-color: rgba(52, 199, 89, 0.36) !important; }
  mark.rh-blue   { background-color: rgba(10, 132, 255, 0.30) !important; }
  mark.rh-pink   { background-color: rgba(255, 55, 135, 0.30) !important; }
  ::selection { background: rgba(47, 93, 80, 0.28); }
  @media (prefers-color-scheme: dark) {
    html, body { color: #ece7dd !important; }
    body * { color: inherit !important; background-color: transparent; border-color: #3a3733; }
    a { color: #86c2ad !important; }
    img { opacity: 0.92; }
    mark.rh-yellow { background-color: rgba(255, 204, 0, 0.32) !important; }
    ::selection { background: rgba(134, 194, 173, 0.35); }
  }
`;

const FAMILIES = {
  original: '',
  serif: 'ui-serif, "New York", "Iowan Old Style", Charter, Georgia, serif',
  sans: '-apple-system, BlinkMacSystemFont, system-ui, "Helvetica Neue", Arial, sans-serif',
};

export class EPUBReader {
  constructor({ container, epub, highlights, callbacks, typography }) {
    this.epub = epub;
    this.highlights = highlights;
    this.cb = callbacks;
    this.typography = typography || { size: 100, family: 'original' };
    this.index = -1;
    this.loadToken = 0;
    this.doc = null;
    this.saved = null;

    this.frame = h('iframe', { class: 'epub-frame', title: 'Book page' });
    this.nextButton = h('button', { class: 'next-chapter', onclick: () => this.go(this.index + 1) },
      h('span', {}, 'Next chapter'), icon('forward'));
    this.endNote = h('div', { class: 'end-of-book' }, 'The end');
    this.scroller = h('div', { class: 'epub-scroller' }, this.frame, h('div', { class: 'chapter-end' }, this.nextButton, this.endNote));
    container.append(this.scroller);
    this.scroller.addEventListener('scroll', () => {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = setTimeout(() => this.emitPosition(), 250);
    }, { passive: true });
  }

  get chapters() { return this.epub.chapters; }

  async open(position = {}) {
    const index = Math.min(Math.max(position.chapter ?? 0, 0), this.chapters.length - 1);
    await this.go(index, { fraction: position.fraction ?? 0 });
  }

  async go(index, { fraction = 0, focusId = null, fragment = null } = {}) {
    if (index < 0 || index >= this.chapters.length) return;
    const token = ++this.loadToken;
    this.index = index;
    this.saved = null;
    this.cb.onSelection?.(false);
    this.cb.onChapter?.(index, this.chapters[index].title);

    const url = await this.epub.chapterURL(index);
    if (token !== this.loadToken) return;
    await new Promise((resolve) => {
      this.frame.onload = () => resolve();
      // replace() so chapter changes don't pile up in the browser's Back history
      try { this.frame.contentWindow.location.replace(url); } catch { this.frame.src = url; }
    });
    if (token !== this.loadToken) return;

    const doc = this.frame.contentDocument;
    this.doc = doc;
    if (!doc?.body) return;
    this.prepare(doc);
    for (const hl of this.highlights) if (hl.chapter === index) HL.paint(doc, hl);

    const last = index === this.chapters.length - 1;
    this.nextButton.hidden = last;
    this.endNote.hidden = !last;

    this.fit();
    const position = () => {
      if (focusId && this.scrollToMark(focusId)) return;
      if (fragment && this.scrollToId(fragment)) return;
      const max = this.scroller.scrollHeight - this.scroller.clientHeight;
      this.scroller.scrollTop = Math.max(0, fraction) * max;
    };
    position();
    this.lastAuto = this.scroller.scrollTop;
    // Pictures may still be loading and change the height — position once more.
    setTimeout(() => {
      if (token === this.loadToken && Math.abs(this.scroller.scrollTop - this.lastAuto) < 2) {
        this.fit();
        position();
      }
      this.emitPosition();
    }, 400);
  }

  prepare(doc) {
    const head = doc.head || doc.documentElement;
    const base = doc.createElementNS(XHTML_NS, 'style');
    base.textContent = BASE_CSS;
    head.appendChild(base);
    this.typoStyle = doc.createElementNS(XHTML_NS, 'style');
    head.appendChild(this.typoStyle);
    this.applyTypography();

    doc.addEventListener('selectionchange', () => this.onSelectionChange());
    doc.addEventListener('click', (e) => this.onClick(e));
    doc.addEventListener('keydown', (e) => this.cb.onKey?.(e));

    this.resizeObserver?.disconnect();
    const RO = this.frame.contentWindow?.ResizeObserver || window.ResizeObserver;
    this.resizeObserver = new RO(() => this.fit());
    this.resizeObserver.observe(doc.body);
    for (const img of doc.querySelectorAll('img')) img.addEventListener('load', () => this.fit());
  }

  fit() {
    if (!this.doc?.body) return;
    const height = Math.ceil(this.doc.body.getBoundingClientRect().bottom);
    this.frame.style.height = `${Math.max(height, 120)}px`;
  }

  applyTypography() {
    if (!this.typoStyle) return;
    const { size, family } = this.typography;
    const font = FAMILIES[family] || '';
    this.typoStyle.textContent =
      `html body { font-size: ${size}% !important; }` +
      (font ? ` html body, html body *:not(code):not(pre):not(kbd):not(samp) { font-family: ${font} !important; }` : '');
  }

  setTypography(typography) {
    const max = this.scroller.scrollHeight - this.scroller.clientHeight;
    const fraction = max > 0 ? this.scroller.scrollTop / max : 0;
    this.typography = typography;
    this.applyTypography();
    requestAnimationFrame(() => {
      this.fit();
      this.scroller.scrollTop = fraction * (this.scroller.scrollHeight - this.scroller.clientHeight);
    });
  }

  // ---- Selection & highlights ----

  onSelectionChange() {
    const sel = this.doc?.getSelection();
    const has = !!(sel && sel.rangeCount && !sel.isCollapsed && sel.toString().trim());
    if (has) this.saved = sel.getRangeAt(0).cloneRange();
    this.cb.onSelection?.(has);
  }

  captureSelection() {
    if (!this.doc) return null;
    const sel = this.doc.getSelection();
    const range = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : this.saved;
    if (!range) return null;
    const result = HL.capture(this.doc, range);
    if (!result) return null;
    sel?.removeAllRanges();
    this.saved = null;
    this.cb.onSelection?.(false);
    return {
      kind: 'epub',
      chapter: this.index,
      chapterTitle: this.chapters[this.index].title,
      start: result.start,
      end: result.end,
      text: result.text,
    };
  }

  paint(hl) { if (this.doc && hl.chapter === this.index) HL.paint(this.doc, hl); }
  unpaint(hl) { if (this.doc) HL.unpaint(this.doc, hl.id); }
  repaint(hl) { if (this.doc) HL.recolor(this.doc, hl.id, hl.color); }

  async jumpTo(hl) {
    if (hl.chapter === this.index) this.scrollToMark(hl.id, true);
    else await this.go(hl.chapter, { focusId: hl.id });
  }

  scrollToMark(id, smooth = false) {
    const mark = this.doc && HL.find(this.doc, id)[0];
    if (!mark) return false;
    const top = this.frame.offsetTop + mark.getBoundingClientRect().top - this.scroller.clientHeight / 3;
    this.scroller.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
    return true;
  }

  scrollToId(id) {
    const el = this.doc?.getElementById(id);
    if (!el) return false;
    this.scroller.scrollTop = Math.max(0, this.frame.offsetTop + el.getBoundingClientRect().top - 24);
    return true;
  }

  onClick(e) {
    const target = e.target?.nodeType === 1 ? e.target : e.target?.parentElement;
    const link = target?.closest?.('a[href]');
    if (link) {
      e.preventDefault();
      this.followLink(link.getAttribute('href') || '');
      return;
    }
    const mark = target?.closest?.('mark.rh');
    if (mark) {
      const sel = this.doc.getSelection();
      if (sel && !sel.isCollapsed) return;
      this.cb.onTap?.(mark.getAttribute('data-hid'));
    }
  }

  followLink(href) {
    if (/^(https?:|mailto:)/i.test(href)) {
      window.open(href, '_blank', 'noopener');
      return;
    }
    const hashAt = href.indexOf('#');
    const fragment = hashAt >= 0 ? decodeURIComponent(href.slice(hashAt + 1)) : null;
    const pathPart = hashAt >= 0 ? href.slice(0, hashAt) : href;
    if (!pathPart) {
      if (fragment) this.scrollToId(fragment);
      return;
    }
    const target = resolvePath(pathPart, dirOf(this.chapters[this.index].path));
    const index = this.chapters.findIndex((c) => c.path === target);
    if (index === this.index) { if (fragment) this.scrollToId(fragment); }
    else if (index >= 0) this.go(index, { fragment });
  }

  // ---- Position ----

  emitPosition() {
    const max = this.scroller.scrollHeight - this.scroller.clientHeight;
    const fraction = max > 0 ? Math.min(1, this.scroller.scrollTop / max) : 0;
    const progress = (this.index + fraction) / this.chapters.length;
    this.cb.onPosition?.({ chapter: this.index, fraction }, progress);
  }

  pageBy(direction) {
    const step = this.scroller.clientHeight * 0.9 * direction;
    this.scroller.scrollBy({ top: step, behavior: 'smooth' });
  }

  destroy() {
    this.loadToken++;
    clearTimeout(this.scrollTimer);
    this.resizeObserver?.disconnect();
    this.scroller.remove();
    this.epub.close();
  }
}
