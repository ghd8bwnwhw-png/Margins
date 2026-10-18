// epub.js — reads an EPUB: title, author, chapter order, table of
// contents, cover, and prepares each chapter as a self-contained page
// whose pictures and styles point inside the unpacked "suitcase".

import { ZipArchive } from './zip.js';

const XLINK_NS = 'http://www.w3.org/1999/xlink';

const MIME = {
  css: 'text/css', xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html',
  xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4',
};

export const mimeFor = (path) => MIME[path.split('.').pop().toLowerCase()] || 'application/octet-stream';

/** "../Text/ch1.xhtml#p3" seen from "OEBPS/Text" → "OEBPS/Text/ch1.xhtml" */
export function resolvePath(href, baseDir) {
  let h = href.split('#')[0].split('?')[0];
  try { h = decodeURIComponent(h); } catch { /* keep as is */ }
  const parts = h.startsWith('/') ? [] : (baseDir ? baseDir.split('/').filter(Boolean) : []);
  for (const c of h.split('/')) {
    if (c === '..') parts.pop();
    else if (c && c !== '.') parts.push(c);
  }
  return parts.join('/');
}

export const dirOf = (p) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

const isExternal = (v) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(v);

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const byTag = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));

function parseXML(text) {
  if (!text) return null;
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  return doc.getElementsByTagName('parsererror').length ? null : doc;
}

function parseDocument(text, preferXML) {
  if (preferXML) {
    const doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
    if (!doc.getElementsByTagName('parsererror').length) return { doc, xml: true };
  }
  return { doc: new DOMParser().parseFromString(text, 'text/html'), xml: false };
}

export async function openEPUB(blob) {
  const zip = await ZipArchive.fromBlob(blob);

  // Copy-protected books encrypt their chapters (DRM-free books may only scramble fonts).
  const encryption = await zip.text('META-INF/encryption.xml');
  if (encryption && /\.x?html?["']/i.test(encryption)) {
    throw new Error('This book is copy-protected (DRM), so it can only be opened in the app or store it was bought from.');
  }

  const container = parseXML(await zip.text('META-INF/container.xml'));
  const opfPath = container && byTag(container, 'rootfile')[0]?.getAttribute('full-path');
  const opf = opfPath && parseXML(await zip.text(opfPath));
  if (!opf) throw new Error('This file doesn’t look like a valid EPUB.');
  const opfDir = dirOf(opfPath);

  const title = clean(byTag(opf, 'title')[0]?.textContent);
  const author = clean(byTag(opf, 'creator')[0]?.textContent);

  // Manifest: every file in the book
  const manifest = new Map();
  for (const item of byTag(opf, 'item')) {
    manifest.set(item.getAttribute('id'), {
      id: item.getAttribute('id'),
      path: resolvePath(item.getAttribute('href') || '', opfDir),
      type: item.getAttribute('media-type') || '',
      props: (item.getAttribute('properties') || '').split(/\s+/),
    });
  }

  // Chapter names from the table of contents
  const toc = new Map();
  const nav = [...manifest.values()].find((m) => m.props.includes('nav'));
  if (nav) {
    const text = await zip.text(nav.path);
    if (text) {
      const { doc } = parseDocument(text, true);
      const navs = byTag(doc, 'nav');
      const tocNav = navs.find((n) => /toc/.test(n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '')) || navs[0] || doc;
      for (const a of byTag(tocNav, 'a')) {
        const href = a.getAttribute('href');
        const label = clean(a.textContent);
        if (!href || !label) continue;
        const path = resolvePath(href, dirOf(nav.path));
        if (!toc.has(path)) toc.set(path, label);
      }
    }
  }
  if (!toc.size) {
    const spineEl = byTag(opf, 'spine')[0];
    const ncx = manifest.get(spineEl?.getAttribute('toc')) ||
      [...manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml');
    const doc = ncx && parseXML(await zip.text(ncx.path));
    if (doc) {
      for (const point of byTag(doc, 'navPoint')) {
        const label = clean(byTag(point, 'text')[0]?.textContent);
        const src = byTag(point, 'content')[0]?.getAttribute('src');
        if (!label || !src) continue;
        const path = resolvePath(src, dirOf(ncx.path));
        if (!toc.has(path)) toc.set(path, label);
      }
    }
  }

  // Spine: the reading order
  const chapters = [];
  let lastTitle = '';
  let n = 0;
  for (const ref of byTag(opf, 'itemref')) {
    const item = manifest.get(ref.getAttribute('idref'));
    if (!item) continue;
    if (item.type && !item.type.includes('html')) continue;
    n += 1;
    const tocTitle = toc.get(item.path);
    if (tocTitle) lastTitle = tocTitle;
    chapters.push({ path: item.path, title: tocTitle || lastTitle || title || `Section ${n}`, isTocEntry: !!tocTitle });
  }
  if (!chapters.length) throw new Error('No readable chapters were found in this EPUB.');

  // Cover picture
  let cover = [...manifest.values()].find((m) => m.props.includes('cover-image'));
  if (!cover) {
    const meta = byTag(opf, 'meta').find((m) => m.getAttribute('name') === 'cover');
    cover = meta && manifest.get(meta.getAttribute('content'));
  }
  if (!cover) {
    cover = [...manifest.values()].find((m) => m.type.startsWith('image/') && /cover/i.test(m.id + m.path));
  }

  return new EPUBBook(zip, { title, author, chapters, coverPath: cover?.type?.startsWith('image/') ? cover.path : null });
}

export class EPUBBook {
  constructor(zip, meta) {
    this.zip = zip;
    this.title = meta.title;
    this.author = meta.author;
    this.chapters = meta.chapters;
    this.coverPath = meta.coverPath;
    this.urls = new Map();
    this.pending = new Map();
    this.chapterURLs = [];
  }

  /** A blob: link to a picture/style/font inside the book. */
  async resourceURL(path) {
    if (this.urls.has(path)) return this.urls.get(path);
    if (this.pending.has(path)) return this.pending.get(path);
    const job = (async () => {
      const bytes = await this.zip.bytesOf(path);
      if (!bytes) return null;
      const type = mimeFor(path);
      const blob = type === 'text/css'
        ? new Blob([await this.rewriteCSS(new TextDecoder().decode(bytes), dirOf(path))], { type })
        : new Blob([bytes], { type });
      const url = URL.createObjectURL(blob);
      this.urls.set(path, url);
      return url;
    })();
    this.pending.set(path, job);
    try { return await job; } finally { this.pending.delete(path); }
  }

  async rewriteCSS(css, dir) {
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    const refs = new Set();
    let m;
    while ((m = re.exec(css))) {
      if (!isExternal(m[2]) && !m[2].startsWith('#')) refs.add(m[2]);
    }
    const map = new Map();
    for (const ref of refs) {
      const url = await this.resourceURL(resolvePath(ref, dir));
      if (url) map.set(ref, url);
    }
    return css.replace(re, (all, q, ref) => (map.has(ref) ? `url("${map.get(ref)}")` : all));
  }

  /** Builds a ready-to-show page for chapter `index` and returns its link. */
  async chapterURL(index) {
    const chapter = this.chapters[index];
    const raw = await this.zip.text(chapter.path);
    if (raw == null) throw new Error('A chapter is missing from this EPUB.');
    const preferXML = /\.(xhtml|xml)$/i.test(chapter.path) || raw.trimStart().startsWith('<?xml');
    const { doc, xml } = parseDocument(raw, preferXML);
    const dir = dirOf(chapter.path);

    // Books may not run their own scripts
    doc.querySelectorAll('script').forEach((s) => s.remove());
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
    doc.querySelectorAll('[srcset]').forEach((el) => el.removeAttribute('srcset'));

    const jobs = [];
    const swap = (el, attr, ns) => {
      const value = ns ? el.getAttributeNS(ns, 'href') : el.getAttribute(attr);
      if (!value || isExternal(value) || value.startsWith('#')) return;
      jobs.push(this.resourceURL(resolvePath(value, dir)).then((url) => {
        if (!url) return;
        if (ns) el.setAttributeNS(ns, 'xlink:href', url);
        else el.setAttribute(attr, url);
      }));
    };
    doc.querySelectorAll('img[src], source[src], video[src], audio[src], embed[src]').forEach((el) => swap(el, 'src'));
    doc.querySelectorAll('video[poster]').forEach((el) => swap(el, 'poster'));
    doc.querySelectorAll('link[href]').forEach((el) => {
      if (/stylesheet/i.test(el.getAttribute('rel') || '')) swap(el, 'href');
    });
    doc.querySelectorAll('image, use').forEach((el) => {
      if (el.getAttributeNS(XLINK_NS, 'href')) swap(el, null, XLINK_NS);
      else if (el.getAttribute('href')) swap(el, 'href');
    });
    for (const style of doc.querySelectorAll('style')) {
      jobs.push(this.rewriteCSS(style.textContent, dir).then((css) => { style.textContent = css; }));
    }
    await Promise.all(jobs);

    const html = xml
      ? new XMLSerializer().serializeToString(doc)
      : '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
    const type = (xml ? 'application/xhtml+xml' : 'text/html') + ';charset=utf-8';
    const url = URL.createObjectURL(new Blob([html], { type }));
    // Keep only the last two chapter pages in memory
    this.chapterURLs.push(url);
    while (this.chapterURLs.length > 2) URL.revokeObjectURL(this.chapterURLs.shift());
    return url;
  }

  /** Small JPEG of the cover for the library shelf. */
  async coverThumbnail(width = 260) {
    if (!this.coverPath) return null;
    const bytes = await this.zip.bytesOf(this.coverPath);
    if (!bytes) return null;
    return thumbnail(new Blob([bytes], { type: mimeFor(this.coverPath) }), width);
  }

  close() {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    for (const url of this.chapterURLs) URL.revokeObjectURL(url);
    this.urls.clear();
    this.chapterURLs = [];
  }
}

async function thumbnail(blob, width) {
  const bitmap = await createImageBitmap(blob);
  const scale = width / bitmap.width;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.82);
}
