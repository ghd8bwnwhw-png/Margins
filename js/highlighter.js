// highlighter.js — the highlighter pen for EPUB pages.
// A highlight is remembered as "characters 1,204 to 1,388 of this
// chapter", so it lands in the same place every time the chapter opens,
// whatever the text size or screen.

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const BLOCKS = new Set(['HTML', 'BODY', 'DIV', 'SECTION', 'ARTICLE', 'UL', 'OL', 'DL', 'TABLE', 'THEAD',
  'TBODY', 'TFOOT', 'TR', 'BLOCKQUOTE', 'FIGURE', 'NAV', 'ASIDE', 'HEADER', 'FOOTER', 'MAIN']);

function textNodes(doc) {
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  const list = [];
  let node;
  while ((node = walker.nextNode())) list.push(node);
  return list;
}

function offsetOf(doc, container, offset) {
  const r = doc.createRange();
  r.setStart(doc.body, 0);
  r.setEnd(container, offset);
  return r.toString().length;
}

export function rangeFromOffsets(doc, start, end) {
  const nodes = textNodes(doc);
  const range = doc.createRange();
  let pos = 0;
  let started = false;
  for (const node of nodes) {
    const len = node.data.length;
    if (!started && start < pos + len) { range.setStart(node, start - pos); started = true; }
    if (started && end <= pos + len) { range.setEnd(node, end - pos); return range; }
    pos += len;
  }
  return null;
}

/** Turns the current selection into {start, end, text}. */
export function capture(doc, range) {
  if (!doc.body || !doc.body.contains(range.commonAncestorContainer)) return null;
  const text = range.toString();
  if (!text.trim()) return null;
  const start = offsetOf(doc, range.startContainer, range.startOffset);
  const end = offsetOf(doc, range.endContainer, range.endOffset);
  if (end <= start) return null;
  return { start, end, text: text.replace(/\s+/g, ' ').trim() };
}

function wrap(doc, range, id, color) {
  const parts = [];
  for (const node of textNodes(doc)) {
    if (!range.intersectsNode(node)) continue;
    const s = node === range.startContainer ? range.startOffset : 0;
    const e = node === range.endContainer ? range.endOffset : node.data.length;
    if (e <= s) continue;
    const parentName = String(node.parentNode?.nodeName || '').toUpperCase();
    if (!node.data.slice(s, e).trim() && BLOCKS.has(parentName)) continue;
    parts.push({ node, s, e });
  }
  for (const { node, s, e } of parts) {
    let target = node;
    if (s > 0) target = target.splitText(s);
    if (e - s < target.data.length) target.splitText(e - s);
    const mark = doc.createElementNS(XHTML_NS, 'mark');
    mark.setAttribute('class', `rh rh-${color}`);
    mark.setAttribute('data-hid', id);
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
  }
}

export function find(doc, id) {
  return Array.from(doc.querySelectorAll(`mark.rh[data-hid="${id}"]`));
}

export function paint(doc, hl) {
  if (!doc?.body) return;
  unpaint(doc, hl.id);
  const range = rangeFromOffsets(doc, hl.start, hl.end);
  if (range) wrap(doc, range, hl.id, hl.color);
}

export function unpaint(doc, id) {
  for (const mark of find(doc, id)) {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

export function recolor(doc, id, color) {
  for (const mark of find(doc, id)) mark.setAttribute('class', `rh rh-${color}`);
}
