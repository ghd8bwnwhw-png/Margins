// pdfreader.js — PDFs drawn with Mozilla's PDF.js (bundled, works offline).
// Pages are drawn only when they come near the screen, like a stage crew
// that only lights the part of the set the audience can see.
// Highlights are stored as rectangles measured in fractions of the page,
// so they fit at every zoom level and screen size.

import * as pdfjsLib from '../vendor/pdfjs/pdf.mjs';
import { h } from './ui.js';

const BASE = new URL('../vendor/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.mjs';

export async function loadPDF(blob) {
  const data = new Uint8Array(await blob.arrayBuffer());
  try {
    return await pdfjsLib.getDocument({
      data,
      standardFontDataUrl: BASE + 'standard_fonts/',
      isEvalSupported: false,
      enableXfa: false,
    }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') throw new Error('This PDF is password-protected.');
    throw new Error('This PDF could not be opened.');
  }
}

/** Title, author, page count and a small picture of page 1 for the shelf. */
export async function pdfInfo(blob) {
  const pdf = await loadPDF(blob);
  try {
    let title = '';
    let author = '';
    try {
      const meta = await pdf.getMetadata();
      title = String(meta?.info?.Title || '').trim();
      author = String(meta?.info?.Author || '').trim();
    } catch { /* no metadata */ }
    if (/^(untitled|microsoft (word|powerpoint))/i.test(title) || /\.(docx?|pdf|indd|pptx?|xlsx?)$/i.test(title)) title = '';

    let cover = null;
    try {
      const page = await pdf.getPage(1);
      const scale = 260 / page.getViewport({ scale: 1 }).width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      cover = canvas.toDataURL('image/jpeg', 0.8);
    } catch { /* no cover */ }
    return { title, author, cover, pageCount: pdf.numPages };
  } finally {
    pdf.destroy();
  }
}

function mergeRects(rects) {
  rects.sort((a, b) => a.p - b.p || a.y - b.y || a.x - b.x);
  const out = [];
  const sameLine = (a, b) => {
    const top = Math.max(a.y, b.y);
    const bottom = Math.min(a.y + a.h, b.y + b.h);
    return bottom - top >= 0.5 * Math.min(a.h, b.h);
  };
  for (const r of rects) {
    const into = out.find((o) => o.p === r.p && sameLine(o, r) && r.x <= o.x + o.w + 0.012 && r.x + r.w >= o.x - 0.012);
    if (into) {
      const x1 = Math.min(into.x, r.x);
      const y1 = Math.min(into.y, r.y);
      const x2 = Math.max(into.x + into.w, r.x + r.w);
      const y2 = Math.max(into.y + into.h, r.y + r.h);
      Object.assign(into, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    } else {
      out.push({ ...r });
    }
  }
  const round = (v) => Math.round(v * 100000) / 100000;
  return out.map((r) => ({ p: r.p, x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) }));
}

export class PDFReader {
  constructor({ container, blob, highlights, callbacks }) {
    this.blob = blob;
    this.highlights = highlights;
    this.cb = callbacks;
    this.zoom = 1;
    this.pages = [];
    this.saved = null;
    this.pagesEl = h('div', { class: 'pdf-pages' });
    this.scroller = h('div', { class: 'pdf-scroller' }, this.pagesEl);
    container.append(this.scroller);
    this.onSelection = () => this.handleSelectionChange();
    document.addEventListener('selectionchange', this.onSelection);
    this.scroller.addEventListener('scroll', () => {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = setTimeout(() => this.emitPosition(), 200);
    }, { passive: true });
  }

  async open(position = {}) {
    this.pdf = await loadPDF(this.blob);
    const n = this.pdf.numPages;
    this.sizes = new Array(n);
    for (let i = 0; i < n; i += 25) {
      const batch = [];
      for (let j = i; j < Math.min(n, i + 25); j++) {
        batch.push(this.pdf.getPage(j + 1).then((page) => {
          const vp = page.getViewport({ scale: 1 });
          this.sizes[j] = { w: vp.width, h: vp.height };
        }));
      }
      await Promise.all(batch);
    }
    this.pages = this.sizes.map((_, i) => {
      const div = h('div', { class: 'pdf-page', 'data-index': i });
      div.addEventListener('click', (e) => this.onPageClick(e, i));
      this.pagesEl.append(div);
      return { div, state: 'empty', token: 0, scale: 1, hlLayer: null, canvas: null, task: null, textLayer: null };
    });
    this.layout();
    this.observe();
    this.restore({ page: position.page ?? 0, offset: position.offset ?? 0 });

    let lastWidth = this.scroller.clientWidth;
    this.resizeObserver = new ResizeObserver(() => {
      const w = this.scroller.clientWidth;
      if (Math.abs(w - lastWidth) > 16) {
        lastWidth = w;
        this.relayout();
      }
    });
    this.resizeObserver.observe(this.scroller);
    this.emitPosition();
  }

  layout() {
    const available = this.scroller.clientWidth;
    const width = Math.round((available - 8) * this.zoom);
    this.pages.forEach((p, i) => {
      const s = this.sizes[i];
      p.scale = width / s.w;
      p.div.style.width = `${width}px`;
      p.div.style.height = `${Math.round(s.h * p.scale)}px`;
      p.div.style.setProperty('--scale-factor', p.scale);
    });
  }

  relayout() {
    const pos = this.position();
    this.pages.forEach((p) => this.unrender(p));
    this.layout();
    this.restore(pos);
    this.observe();
  }

  setZoom(zoom) {
    this.zoom = Math.min(3, Math.max(1, Math.round(zoom * 4) / 4));
    this.relayout();
    return this.zoom;
  }

  observe() {
    this.io?.disconnect();
    this.io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const i = Number(entry.target.dataset.index);
        if (entry.isIntersecting) this.render(i);
        else this.unrender(this.pages[i]);
      }
    }, { root: this.scroller, rootMargin: '120% 0px' });
    this.pages.forEach((p) => this.io.observe(p.div));
  }

  async render(i) {
    const p = this.pages[i];
    if (!p || p.state !== 'empty') return;
    p.state = 'rendering';
    const token = ++p.token;
    try {
      const page = await this.pdf.getPage(i + 1);
      if (p.token !== token) return;
      const viewport = page.getViewport({ scale: p.scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = h('canvas', { class: 'pdf-canvas' });
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      const hlLayer = h('div', { class: 'pdf-hl-layer' });
      const textLayer = h('div', { class: 'textLayer' });
      p.div.replaceChildren(canvas, hlLayer, textLayer);
      p.canvas = canvas;
      p.hlLayer = hlLayer;
      this.drawHighlights(i);

      p.task = page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      await p.task.promise;
      if (p.token !== token) return;
      p.textLayer = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: textLayer, viewport });
      await p.textLayer.render();
      if (p.token === token) p.state = 'done';
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException' && e?.name !== 'AbortException') console.warn('Page render failed', e);
      if (p.token === token) p.state = 'empty';
    }
  }

  unrender(p) {
    if (!p || p.state === 'empty') return;
    // Keep pages that hold the current selection
    const sel = document.getSelection();
    if (sel?.rangeCount && !sel.isCollapsed && p.div.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
    p.token++;
    try { p.task?.cancel(); } catch { /* already done */ }
    try { p.textLayer?.cancel(); } catch { /* already done */ }
    if (p.canvas) { p.canvas.width = 0; p.canvas.height = 0; }
    p.div.replaceChildren();
    p.canvas = p.hlLayer = p.task = p.textLayer = null;
    p.state = 'empty';
  }

  drawHighlights(i) {
    const p = this.pages[i];
    if (!p?.hlLayer) return;
    const boxes = [];
    for (const hl of this.highlights) {
      for (const r of hl.rects || []) {
        if (r.p !== i) continue;
        boxes.push(h('div', {
          class: `pdf-hl hl-${hl.color}`,
          'data-hid': hl.id,
          style: { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` },
        }));
      }
    }
    p.hlLayer.replaceChildren(...boxes);
  }

  // ---- Selection & highlights ----

  selectionRange() {
    const sel = document.getSelection();
    if (sel?.rangeCount && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      if (this.pagesEl.contains(range.commonAncestorContainer)) return range;
    }
    return null;
  }

  handleSelectionChange() {
    const range = this.selectionRange();
    const has = !!(range && range.toString().trim());
    if (has) this.saved = range.cloneRange();
    this.cb.onSelection?.(has);
  }

  captureSelection() {
    const range = this.selectionRange() || this.saved;
    if (!range) return null;
    const text = range.toString().replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const pageRects = this.pages.map((p) => p.div.getBoundingClientRect());
    const rects = [];
    for (const cr of range.getClientRects()) {
      if (cr.width < 1 || cr.height < 1) continue;
      const cx = cr.left + cr.width / 2;
      const cy = cr.top + cr.height / 2;
      const pi = pageRects.findIndex((pr) => cx >= pr.left && cx <= pr.right && cy >= pr.top && cy <= pr.bottom);
      if (pi < 0) continue;
      const pr = pageRects[pi];
      if (cr.height > pr.height * 0.15) continue; // a whole block, not a line of text
      rects.push({
        p: pi,
        x: Math.max(0, (cr.left - pr.left) / pr.width),
        y: Math.max(0, (cr.top - pr.top) / pr.height),
        w: Math.min(1, cr.width / pr.width),
        h: Math.min(1, cr.height / pr.height),
      });
    }
    if (!rects.length) return null;
    const merged = mergeRects(rects);
    document.getSelection()?.removeAllRanges();
    this.saved = null;
    this.cb.onSelection?.(false);
    return { kind: 'pdf', page: merged[0].p, rects: merged, text };
  }

  pagesOf(hl) { return [...new Set((hl.rects || []).map((r) => r.p))]; }
  paint(hl) { this.pagesOf(hl).forEach((i) => this.drawHighlights(i)); }
  unpaint(hl) { this.pagesOf(hl).forEach((i) => this.drawHighlights(i)); }
  repaint(hl) { this.paint(hl); }

  jumpTo(hl) {
    const r = hl.rects?.[0];
    const p = this.pages[r ? r.p : hl.page];
    if (!p) return;
    const top = p.div.offsetTop + (r ? r.y * p.div.offsetHeight : 0) - this.scroller.clientHeight / 3;
    this.scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  onPageClick(e, i) {
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed) return;
    const pr = this.pages[i].div.getBoundingClientRect();
    const x = (e.clientX - pr.left) / pr.width;
    const y = (e.clientY - pr.top) / pr.height;
    const pad = 0.004;
    const hit = this.highlights.find((hl) => (hl.rects || []).some((r) =>
      r.p === i && x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad));
    if (hit) this.cb.onTap?.(hit.id);
  }

  // ---- Position ----

  position() {
    const top = this.scroller.scrollTop;
    let lo = 0;
    let hi = this.pages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.pages[mid].div.offsetTop <= top + 1) lo = mid; else hi = mid - 1;
    }
    const p = this.pages[lo];
    const offset = p ? Math.min(1, Math.max(0, (top - p.div.offsetTop) / p.div.offsetHeight)) : 0;
    return { page: lo, offset };
  }

  restore({ page = 0, offset = 0 }) {
    const p = this.pages[Math.min(Math.max(page, 0), this.pages.length - 1)];
    if (p) this.scroller.scrollTop = p.div.offsetTop + offset * p.div.offsetHeight;
  }

  emitPosition() {
    if (!this.pages.length) return;
    const pos = this.position();
    const n = this.pages.length;
    const progress = (pos.page + pos.offset) / n;
    this.cb.onPosition?.(pos, progress, `Page ${pos.page + 1} of ${n}`);
  }

  pageBy(direction) {
    this.scroller.scrollBy({ top: this.scroller.clientHeight * 0.9 * direction, behavior: 'smooth' });
  }

  destroy() {
    document.removeEventListener('selectionchange', this.onSelection);
    clearTimeout(this.scrollTimer);
    this.io?.disconnect();
    this.resizeObserver?.disconnect();
    this.pages.forEach((p) => this.unrender(p));
    this.scroller.remove();
    this.pdf?.destroy();
  }
}
