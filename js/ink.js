// ink.js — handwriting with Apple Pencil. Think of a sheet of tracing
// paper laid over the page: the book underneath is never changed, and
// each drawing is pinned to the words it was drawn next to, so it stays
// with them.
//
// A "handwritten note" is a group of strokes drawn one after another
// (a circle, an arrow and a comment written within a few seconds of
// each other belong together). It's stored alongside highlights, so it
// is backed up and synced the same way.
//
// Each reader (EPUB / PDF) tells this file where its pages are:
//   inkSurfaceAt(x, y)  → { id, el } the drawing sheet under a point
//   inkSurfaceEl(id)    → that sheet's <svg>
//   inkSurfaceIds()     → the sheets currently on screen
//   inkNewGroup(id,x,y) → where a new note is pinned (chapter + word, or page)
//   inkFrame(group)     → { surfaceId, ox, oy, scale, prec }: how to turn the
//                         stored numbers back into positions on screen
//   inkFinish(group)    → fills in the nearby text, for the notes list
//   inkJump(group)      → scrolls to it

const SVG = 'http://www.w3.org/2000/svg';
export const PEN_COLORS = ['ink', 'red', 'blue', 'green'];
export const PEN_LABELS = { ink: 'Black', red: 'Red', blue: 'Blue', green: 'Green' };
const WIDTH = 2.4;        // pen width on screen, in pixels
const ERASER = 14;        // eraser reach, in pixels
const GROUP_MS = 4500;    // strokes this close in time belong to one note…
const NEAR_PX = 240;      // …if they're also this close on the page

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export function inkSurface(className = 'ink-layer') {
  return svg('svg', { class: className, 'aria-hidden': 'true' });
}

/** A smooth line through the points (curves drawn between midpoints). */
export function pathData(pts) {
  if (!pts.length) return '';
  const f = (n) => (Math.round(n * 10) / 10).toString();
  const [x0, y0] = pts[0];
  if (pts.length === 1) return `M${f(x0)} ${f(y0)}l0.1 0`;
  let d = `M${f(x0)} ${f(y0)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i];
    const [nx, ny] = pts[i + 1];
    d += `Q${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`;
  }
  const [xl, yl] = pts[pts.length - 1];
  return `${d}L${f(xl)} ${f(yl)}`;
}

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function bounds(pointLists) {
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  for (const pts of pointLists) {
    for (const [x, y] of pts) {
      if (x < x1) x1 = x;
      if (y < y1) y1 = y;
      if (x > x2) x2 = x;
      if (y > y2) y2 = y;
    }
  }
  return { x1, y1, x2, y2 };
}

/** The drawing's outline in its own stored units. */
export function inkBounds(group) {
  return bounds((group.strokes || []).map((s) => s.p));
}

/**
 * The part of the page a note is "about": the inside of any circle
 * (a stroke that ends where it began), otherwise the first stroke.
 */
export function inkFocus(group) {
  const strokes = group.strokes || [];
  const closed = strokes.filter(({ p }) => {
    if (p.length < 8) return false;
    const b = bounds([p]);
    const size = Math.hypot(b.x2 - b.x1, b.y2 - b.y1);
    const [x0, y0] = p[0];
    const [x1, y1] = p[p.length - 1];
    return size > 0 && Math.hypot(x1 - x0, y1 - y0) < size * 0.35;
  });
  return { box: bounds((closed.length ? closed : strokes.slice(0, 1)).map((s) => s.p)), circled: closed.length > 0 };
}

/** A small picture of a handwritten note, at its real size (shrunk to fit). */
export function inkPreview(group, { maxHeight = 96 } = {}) {
  const strokes = group.strokes || [];
  const b = inkBounds(group);
  const avgW = strokes.reduce((a, s) => a + s.w, 0) / Math.max(strokes.length, 1) || 1;
  const k = WIDTH / avgW;               // stored units → screen pixels, as when it was drawn
  const pad = 8;
  const vw = Math.max(b.x2 - b.x1, 0) * k + pad * 2;
  const vh = Math.max(b.y2 - b.y1, 0) * k + pad * 2;
  const el = svg('svg', { class: 'ink-preview', viewBox: `0 0 ${vw.toFixed(1)} ${vh.toFixed(1)}`, width: vw.toFixed(0), height: vh.toFixed(0), role: 'img', 'aria-label': 'Handwritten note' });
  el.style.maxHeight = `${maxHeight}px`;
  for (const s of strokes) {
    const pts = s.p.map(([x, y]) => [(x - b.x1) * k + pad, (y - b.y1) * k + pad]);
    el.append(svg('path', { d: pathData(pts), class: `ink-stroke pen-${s.c}`, 'stroke-width': (s.w * k).toFixed(2), 'vector-effect': 'non-scaling-stroke' }));
  }
  return el;
}

export class InkController {
  constructor({ reader, scroller, groups, bookId, onSave, onDelete }) {
    this.reader = reader;
    this.scroller = scroller;
    this.groups = groups;           // shared with the highlights list
    this.bookId = bookId;
    this.onSave = onSave;
    this.onDelete = onDelete;
    this.active = false;
    this.tool = 'pen';
    this.color = 'ink';
    this.finger = false;            // true: one finger draws, two fingers scroll
    this.undoStack = [];
    this.live = null;
    this.current = null;
    this.lastEnd = 0;
    this.touchCapable = 'ontouchstart' in window;
    reader.ink = this;

    // Touch events (iPad/iPhone): Apple Pencil arrives as a touch of type "stylus".
    // Cancelling it stops the page from scrolling, while fingers keep scrolling.
    this.h = {
      ts: (e) => this.onTouchStart(e),
      tm: (e) => this.onTouchMove(e),
      te: (e) => this.onTouchEnd(e),
      pd: (e) => this.onPointerDown(e),
      pm: (e) => this.onPointerMove(e),
      pu: (e) => this.onPointerUp(e),
    };
    scroller.addEventListener('touchstart', this.h.ts, { passive: false });
    scroller.addEventListener('touchmove', this.h.tm, { passive: false });
    scroller.addEventListener('touchend', this.h.te);
    scroller.addEventListener('touchcancel', this.h.te);
    // Mouse, trackpad (and a pen on computers without touch events)
    scroller.addEventListener('pointerdown', this.h.pd);
    window.addEventListener('pointermove', this.h.pm, { passive: false });
    window.addEventListener('pointerup', this.h.pu);
    window.addEventListener('pointercancel', this.h.pu);
  }

  setActive(on) {
    if (!on) this.finish();
    this.active = on;
    this.current = null;
    this.scroller.classList.toggle('pen-mode', on);
  }

  setTool(tool) { this.tool = tool; this.current = null; }

  // ---- Input ----

  onTouchStart(e) {
    if (!this.active) return;
    // A second finger while drawing with a finger: switch to scrolling
    if (this.finger && e.touches.length === 2 && this.touchId != null && !this.touchStylus) {
      this.cancelLive();
      this.touchId = null;
      this.pan = this.midY(e.touches);
      e.preventDefault();
      return;
    }
    if (this.pan != null) { e.preventDefault(); return; }
    if (this.touchId != null) {
      // Already writing: ignore a resting hand, and don't let it scroll the page
      if (this.touchStylus) e.preventDefault();
      return;
    }
    const t = e.changedTouches[0];
    const stylus = t.touchType === 'stylus';
    if (!stylus && !(this.finger && e.touches.length === 1)) return;
    if (this.begin(t.clientX, t.clientY)) {
      e.preventDefault();
      this.touchId = t.identifier;
      this.touchStylus = stylus;
    }
  }

  onTouchMove(e) {
    if (!this.active) return;
    if (this.pan != null) {
      if (e.touches.length >= 2) {
        const y = this.midY(e.touches);
        this.scroller.scrollTop -= y - this.pan;
        this.pan = y;
      }
      e.preventDefault();
      return;
    }
    if (this.touchId == null) return;
    e.preventDefault();
    for (const t of e.changedTouches) if (t.identifier === this.touchId) this.move(t.clientX, t.clientY);
  }

  onTouchEnd(e) {
    if (this.pan != null) {
      if (e.touches.length === 0) this.pan = null;
      return;
    }
    if (this.touchId == null) return;
    for (const t of e.changedTouches) {
      if (t.identifier === this.touchId) {
        this.touchId = null;
        this.end();
      }
    }
  }

  midY(touches) { return (touches[0].clientY + touches[1].clientY) / 2; }

  onPointerDown(e) {
    if (!this.active || e.button > 0 || e.pointerType === 'touch') return;
    if (e.pointerType === 'pen' && this.touchCapable) return; // handled as a touch
    if (this.begin(e.clientX, e.clientY)) {
      e.preventDefault();
      this.pointerId = e.pointerId;
    }
  }

  onPointerMove(e) {
    if (this.pointerId == null || e.pointerId !== this.pointerId) return;
    e.preventDefault();
    const list = e.getCoalescedEvents?.() || [];
    for (const ev of list.length ? list : [e]) this.move(ev.clientX, ev.clientY);
  }

  onPointerUp(e) {
    if (this.pointerId == null || e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.end();
  }

  // ---- Drawing ----

  begin(cx, cy) {
    if (this.tool === 'eraser') {
      this.erasing = true;
      this.eraseAt(cx, cy);
      return true;
    }
    const s = this.reader.inkSurfaceAt(cx, cy);
    if (!s) return false;
    const path = svg('path', { class: `ink-stroke pen-${this.color}`, 'stroke-width': WIDTH });
    s.el.append(path);
    this.live = { s, rect: s.el.getBoundingClientRect(), pts: [], path };
    this.move(cx, cy);
    return true;
  }

  move(cx, cy) {
    if (this.erasing) { this.eraseAt(cx, cy); return; }
    const live = this.live;
    if (!live) return;
    const x = cx - live.rect.left;
    const y = cy - live.rect.top;
    const last = live.pts[live.pts.length - 1];
    if (last && Math.hypot(x - last[0], y - last[1]) < 1.2) return;
    live.pts.push([x, y]);
    live.path.setAttribute('d', pathData(live.pts));
  }

  end() {
    if (this.erasing) { this.erasing = false; return; }
    this.commit();
  }

  cancelLive() {
    this.live?.path.remove();
    this.live = null;
  }

  /** Stop any stroke in progress (keeping what was drawn). */
  finish() {
    this.touchId = null;
    this.pointerId = null;
    this.pan = null;
    if (this.live) this.commit();
    this.erasing = false;
  }

  frameOf(g) {
    try { return this.reader.inkFrame(g); } catch { return null; }
  }

  /** Where a note's strokes are on screen right now, in the sheet's pixels. */
  screenStrokes(g, f = this.frameOf(g)) {
    if (!f) return [];
    return (g.strokes || []).map((s) => ({
      s,
      w: s.w * f.scale,
      pts: s.p.map(([x, y]) => [f.ox + x * f.scale, f.oy + y * f.scale]),
    }));
  }

  near(g, pts, surfaceId) {
    const f = this.frameOf(g);
    if (!f || f.surfaceId !== surfaceId) return false;
    const a = bounds(this.screenStrokes(g, f).map((x) => x.pts));
    const b = bounds([pts]);
    return b.x1 < a.x2 + NEAR_PX && b.x2 > a.x1 - NEAR_PX && b.y1 < a.y2 + NEAR_PX && b.y2 > a.y1 - NEAR_PX;
  }

  commit() {
    const live = this.live;
    this.live = null;
    if (!live) return;
    live.path.remove();
    const { s, pts } = live;
    if (!pts.length) return;
    const now = Date.now();
    let g = this.current;
    const joins = g && !g.deleted && this.groups.includes(g) && now - this.lastEnd < GROUP_MS && this.near(g, pts, s.id);
    if (!joins) {
      const base = this.reader.inkNewGroup(s.id, pts[0][0], pts[0][1]);
      if (!base) { this.renderSurface(s.id); return; }
      g = { id: crypto.randomUUID(), bookId: this.bookId, ink: true, color: 'ink', note: '', text: '', createdAt: now, updatedAt: now, ...base, strokes: [] };
      this.groups.push(g);
    }
    const f = this.frameOf(g);
    if (!f) { this.renderSurface(s.id); return; }
    const r = (v) => Math.round(v * f.prec) / f.prec;
    const stroke = {
      c: this.color,
      w: r(WIDTH / f.scale),
      p: pts.map(([x, y]) => [r((x - f.ox) / f.scale), r((y - f.oy) / f.scale)]),
    };
    g.strokes.push(stroke);
    this.undoStack.push({ type: 'add', g, stroke });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.current = g;
    this.lastEnd = now;
    this.changed(g, s.id);
  }

  eraseAt(cx, cy) {
    const s = this.reader.inkSurfaceAt(cx, cy);
    if (!s) return;
    const rect = s.el.getBoundingClientRect();
    const x = cx - rect.left;
    const y = cy - rect.top;
    for (const g of [...this.groups]) {
      if (!g.ink || g.deleted) continue;
      const f = this.frameOf(g);
      if (!f || f.surfaceId !== s.id) continue;
      const strokes = this.screenStrokes(g, f);
      for (let i = strokes.length - 1; i >= 0; i--) {
        const { pts, w } = strokes[i];
        const reach = ERASER + w / 2;
        const hit = pts.length === 1
          ? Math.hypot(x - pts[0][0], y - pts[0][1]) <= reach
          : pts.some((p, j) => j > 0 && distToSegment(x, y, pts[j - 1], p) <= reach);
        if (!hit) continue;
        const [stroke] = g.strokes.splice(i, 1);
        this.undoStack.push({ type: 'erase', g, stroke, i });
        this.changed(g, s.id);
      }
    }
  }

  /** Takes back the last stroke drawn or erased. */
  undo() {
    this.finish();
    const u = this.undoStack.pop();
    if (!u) return false;
    const { g } = u;
    if (u.type === 'add') {
      const i = g.strokes.lastIndexOf(u.stroke);
      if (i >= 0) g.strokes.splice(i, 1);
    } else {
      if (g.deleted || !this.groups.includes(g)) {
        g.deleted = false;
        if (!this.groups.includes(g)) this.groups.push(g);
      }
      g.strokes.splice(Math.min(u.i, g.strokes.length), 0, u.stroke);
    }
    this.current = null;
    this.changed(g, this.frameOf(g)?.surfaceId);
    return true;
  }

  changed(g, surfaceId) {
    if (!g.strokes.length) {
      if (this.current === g) this.current = null;
      g.deleted = true;
      this.onDelete(g);
    } else {
      g.deleted = false;
      g.updatedAt = Date.now();
      try { this.reader.inkFinish?.(g); } catch { /* nearby text is optional */ }
      this.onSave(g);
    }
    if (surfaceId != null) this.renderSurface(surfaceId);
  }

  // ---- Showing ----

  renderSurface(id) {
    const el = this.reader.inkSurfaceEl(id);
    if (!el) return;
    const paths = [];
    for (const g of this.groups) {
      if (!g.ink || g.deleted) continue;
      const f = this.frameOf(g);
      if (!f || f.surfaceId !== id) continue;
      for (const { s, pts, w } of this.screenStrokes(g, f)) {
        paths.push(svg('path', { d: pathData(pts), class: `ink-stroke pen-${s.c}`, 'stroke-width': w.toFixed(2), 'data-hid': g.id }));
      }
    }
    el.replaceChildren(...paths);
    if (this.live?.s.id === id) el.append(this.live.path);
  }

  renderAll() {
    for (const id of this.reader.inkSurfaceIds()) this.renderSurface(id);
  }

  destroy() {
    this.finish();
    const s = this.scroller;
    s.removeEventListener('touchstart', this.h.ts);
    s.removeEventListener('touchmove', this.h.tm);
    s.removeEventListener('touchend', this.h.te);
    s.removeEventListener('touchcancel', this.h.te);
    s.removeEventListener('pointerdown', this.h.pd);
    window.removeEventListener('pointermove', this.h.pm);
    window.removeEventListener('pointerup', this.h.pu);
    window.removeEventListener('pointercancel', this.h.pu);
  }
}
