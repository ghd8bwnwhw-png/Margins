// pdfreader.js — PDFs drawn with Mozilla's PDF.js (bundled, works offline).
// Pages are drawn only when they come near the screen, like a stage crew
// that only lights the part of the set the audience can see.
// Highlights are stored as rectangles measured in fractions of the page,
// so they fit at every zoom level and screen size.

import { splitSentences } from './speech.js';
import * as pdfjsLib from '../vendor/pdfjs/pdf.mjs';
import { h } from './ui.js';
import { inkSurface, inkBounds, inkFocus, drawStrokes } from './ink.js';

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

/** The piece of the page around a handwritten note, with the drawing on it. */
export async function inkPageCrop(pdf, g, { width = 1100 } = {}) {
  const page = await pdf.getPage(g.page + 1);
  const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
  const full = document.createElement('canvas');
  full.width = Math.round(viewport.width);
  full.height = Math.round(viewport.height);
  const fctx = full.getContext('2d');
  fctx.fillStyle = '#fff';
  fctx.fillRect(0, 0, full.width, full.height);
  await page.render({ canvasContext: fctx, viewport }).promise;
  const b = inkBounds(g);
  const m = 70;
  const x1 = Math.max(0, Math.floor(b.x1 * width - m * 2));
  const x2 = Math.min(full.width, Math.ceil(b.x2 * width + m * 2));
  const y1 = Math.max(0, Math.floor(b.y1 * width - m));
  const y2 = Math.min(full.height, Math.ceil(b.y2 * width + m));
  const crop = document.createElement('canvas');
  crop.width = Math.max(1, x2 - x1);
  crop.height = Math.max(1, y2 - y1);
  const ctx = crop.getContext('2d');
  ctx.drawImage(full, x1, y1, crop.width, crop.height, 0, 0, crop.width, crop.height);
  drawStrokes(ctx, g, { k: width, ox: -x1, oy: -y1, minWidth: 2 });
  full.width = full.height = 0;
  return crop;
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
      return { div, state: 'empty', token: 0, scale: 1, hlLayer: null, inkLayer: null, canvas: null, task: null, textLayer: null };
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
      const inkLayer = inkSurface('ink-layer pdf-ink');
      p.div.replaceChildren(canvas, hlLayer, textLayer, inkLayer);
      p.canvas = canvas;
      p.hlLayer = hlLayer;
      p.inkLayer = inkLayer;
      this.drawHighlights(i);
      this.ink?.renderSurface(`p${i}`);

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
    p.canvas = p.hlLayer = p.inkLayer = p.task = p.textLayer = null;
    p.state = 'empty';
  }

  drawHighlights(i) {
    const p = this.pages[i];
    if (!p?.hlLayer) return;
    const boxes = [];
    for (const hl of this.highlights) {
      if (hl.ink) continue;
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
    if (hl.ink) { this.inkJump(hl); return; }
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
    const hit = this.highlights.find((hl) => !hl.ink && (hl.rects || []).some((r) =>
      r.p === i && x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad));
    if (hit) this.cb.onTap?.(hit.id);
  }

  // ---- Handwriting (see ink.js) ----
  // Strokes are measured in fractions of the page's width, like the
  // highlights, so they sit in the same place at every zoom level.

  inkSurfaceIds() { return this.pages.map((p, i) => (p.inkLayer ? `p${i}` : null)).filter(Boolean); }
  inkSurfaceEl(id) { return this.pages[Number(String(id).slice(1))]?.inkLayer || null; }

  inkSurfaceAt(x, y) {
    for (let i = 0; i < this.pages.length; i++) {
      const p = this.pages[i];
      if (!p.inkLayer) continue;
      const r = p.div.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { id: `p${i}`, el: p.inkLayer };
    }
    return null;
  }

  inkNewGroup(id) {
    const page = Number(String(id).slice(1));
    return this.pages[page] ? { kind: 'pdf', page } : null;
  }

  inkFrame(g) {
    const p = this.pages[g.page];
    if (!p?.inkLayer) return null;
    return { surfaceId: `p${g.page}`, ox: 0, oy: 0, scale: p.div.offsetWidth, prec: 10000 };
  }

  /** Words of the page under or next to the drawing, and its height on the page. */
  inkFinish(g) {
    const p = this.pages[g.page];
    if (!p) return;
    const b = inkBounds(g);
    const s = this.sizes[g.page];
    g.y = Math.round(b.y1 * (s.w / s.h) * 100000) / 100000; // for sorting with highlights
    const box = p.div.getBoundingClientRect();
    const w = box.width;
    const f = inkFocus(g).box;
    const area = { l: box.left + f.x1 * w - 8, r: box.left + f.x2 * w + 8, t: box.top + f.y1 * w - 8, b: box.top + f.y2 * w + 8 };
    const words = [];
    for (const span of p.div.querySelectorAll('.textLayer span:not(.markedContent)')) {
      const r = span.getBoundingClientRect();
      if (r.right > area.l && r.left < area.r && r.bottom > area.t && r.top < area.b && span.textContent.trim()) words.push(span.textContent);
    }
    const text = words.join(' ').replace(/\s+/g, ' ').trim();
    g.text = text.length > 220 ? `${text.slice(0, 217).trim()}…` : text;
  }

  inkJump(g) {
    const p = this.pages[g.page];
    if (!p) return;
    const y = inkBounds(g).y1 * p.div.offsetWidth;
    this.scroller.scrollTo({ top: Math.max(0, p.div.offsetTop + y - this.scroller.clientHeight / 3), behavior: 'smooth' });
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

  // ---- Read aloud ----

  /** The words of one page, as plain sentences. */
  async pageSentences(i) {
    this.textCache ??= new Map();
    if (this.textCache.has(i)) return this.textCache.get(i);
    const page = await this.pdf.getPage(i + 1);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue;
      text += item.str;
      if (item.hasEOL) text = /[-\u00ad]$/.test(text) ? text.replace(/[-\u00ad]$/, '') : `${text} `;
    }
    text = text.replace(/\s+/g, ' ').trim();
    const units = splitSentences(text).map(([a, b]) => ({ text: text.slice(a, b).trim(), page: i })).filter((u) => u.text);
    if (this.textCache.size > 20) this.textCache.clear();
    this.textCache.set(i, units);
    return units;
  }

  async speechSection() {
    this.speechPage = this.position().page;
    return { units: await this.pageSentences(this.speechPage), start: 0 };
  }

  async speechNextSection() {
    while (this.speechPage < this.pages.length - 1) {
      this.speechPage++;
      const units = await this.pageSentences(this.speechPage);
      if (units.length) return { units, start: 0 };
    }
    return null;
  }

  speechInView(unit) {
    if (unit?.page == null || !this.pages[unit.page]) return false;
    const div = this.pages[unit.page].div;
    const top = this.scroller.scrollTop;
    return div.offsetTop + div.offsetHeight > top && div.offsetTop < top + this.scroller.clientHeight;
  }

  speechShow(unit) {
    // Bring the page being read onto the screen when the narrator reaches it
    if (!this.speechInView(unit)) {
      const div = this.pages[unit.page]?.div;
      if (div) this.scroller.scrollTo({ top: div.offsetTop - 4, behavior: 'smooth' });
    }
  }

  speechClear() {}

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
