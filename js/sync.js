// sync.js — keeps devices in step through one file, margins-sync.json,
// kept in iCloud Drive. Think of it as a shared notebook on a table:
// each device reads it, adds what it knows, and puts it back.
//
// Rules when two devices disagree:
//  • the most recently edited version of a highlight wins
//  • a deletion wins unless the highlight was edited after it was deleted
//  • the most recent reading position wins
// Highlights for a book that isn't on this device are kept in the file
// and appear automatically once you import that book here.

import * as db from './db.js';

const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Same book on different devices = same format, file size and title. */
export const bookKey = (b) => `${b.format}|${b.size || 0}|${norm(b.title)}`;

function splitKey(key) {
  const a = key.indexOf('|');
  const b = key.indexOf('|', a + 1);
  return { format: key.slice(0, a), size: Number(key.slice(a + 1, b)), title: key.slice(b + 1) };
}

function findBook(books, key) {
  const exact = books.find((b) => bookKey(b) === key);
  if (exact) return exact;
  const { format, title } = splitKey(key);
  return books.find((b) => b.format === format && norm(b.title) === title) || null;
}

const emptyDoc = () => ({ app: 'margins', kind: 'sync', version: 1, savedAt: 0, books: [], highlights: [], deleted: [] });

async function localDoc() {
  const books = await db.getAll('books');
  const highlights = await db.getAll('highlights');
  const deleted = await db.getAll('deleted');
  const keyOf = new Map(books.map((b) => [b.id, bookKey(b)]));
  return {
    books: books.map((b) => ({
      key: keyOf.get(b.id), title: b.title, author: b.author, format: b.format, size: b.size,
      position: b.position || {}, progress: b.progress || 0, positionUpdatedAt: b.positionUpdatedAt || 0,
    })),
    highlights: highlights
      .filter((h) => keyOf.has(h.bookId))
      .map(({ bookId, deleted: _gone, ...rest }) => ({ ...rest, bookKey: keyOf.get(bookId) })),
    deleted: deleted.map((d) => ({ id: d.id, bookKey: d.bookKey, deletedAt: d.deletedAt })),
  };
}

export function mergeDocs(...docs) {
  const highlights = new Map();
  const deleted = new Map();
  const books = new Map();
  for (const doc of docs) {
    if (!doc) continue;
    for (const h of doc.highlights || []) {
      const cur = highlights.get(h.id);
      if (!cur || (h.updatedAt || 0) > (cur.updatedAt || 0)) highlights.set(h.id, h);
    }
    for (const d of doc.deleted || []) {
      const cur = deleted.get(d.id);
      if (!cur || d.deletedAt > cur.deletedAt) deleted.set(d.id, d);
    }
    for (const b of doc.books || []) {
      const cur = books.get(b.key);
      if (!cur) books.set(b.key, { ...b });
      else if ((b.positionUpdatedAt || 0) > (cur.positionUpdatedAt || 0)) {
        books.set(b.key, { ...cur, position: b.position, progress: b.progress, positionUpdatedAt: b.positionUpdatedAt });
      }
    }
  }
  for (const [id, d] of deleted) {
    const h = highlights.get(id);
    if (!h) continue;
    if ((h.updatedAt || 0) <= d.deletedAt) highlights.delete(id);
    else deleted.delete(id); // edited after deletion → keep it
  }
  return { ...emptyDoc(), savedAt: Date.now(), books: [...books.values()], highlights: [...highlights.values()], deleted: [...deleted.values()] };
}

/** Brings the merged notebook's contents into this device's library. */
async function applyToLocal(merged) {
  const books = await db.getAll('books');
  const stats = { added: 0, updated: 0, removed: 0, positions: 0, waiting: 0 };

  for (const h of merged.highlights) {
    const book = findBook(books, h.bookKey);
    if (!book) { stats.waiting++; continue; }
    const local = await db.get('highlights', h.id);
    if (!local || (local.updatedAt || 0) < (h.updatedAt || 0)) {
      const { bookKey: _key, ...rest } = h;
      await db.put('highlights', { ...rest, bookId: book.id });
      if (local) stats.updated++; else stats.added++;
    }
  }
  for (const d of merged.deleted) {
    await db.put('deleted', d);
    const local = await db.get('highlights', d.id);
    if (local && (local.updatedAt || 0) <= d.deletedAt) {
      await db.del('highlights', d.id);
      stats.removed++;
    }
  }
  for (const b of merged.books) {
    const book = findBook(books, b.key);
    if (book && (b.positionUpdatedAt || 0) > (book.positionUpdatedAt || 0)) {
      Object.assign(book, { position: b.position, progress: b.progress, positionUpdatedAt: b.positionUpdatedAt });
      await db.put('books', book);
      stats.positions++;
    }
  }
  return stats;
}

/** Accepts a sync file, or an older backup file (converted on the fly). */
function readDoc(data) {
  if (data?.app !== 'margins' || !Array.isArray(data.highlights)) {
    throw new Error('This isn’t a Margins sync file. Choose “margins-sync.json”.');
  }
  if (data.kind === 'sync') return data;
  const keyOf = new Map((data.books || []).map((b) => [b.id, bookKey(b)]));
  return {
    ...emptyDoc(),
    books: (data.books || []).map((b) => ({ key: bookKey(b), title: b.title, author: b.author, format: b.format, size: b.size })),
    highlights: data.highlights.filter((h) => keyOf.has(h.bookId)).map(({ bookId, ...rest }) => ({ ...rest, bookKey: keyOf.get(bookId) })),
  };
}

async function storedDoc() {
  return (await db.get('meta', 'sync'))?.doc || null;
}

async function remember(doc) {
  await db.put('meta', { id: 'sync', doc, at: Date.now() });
}

export async function lastSyncTime() {
  return (await db.get('meta', 'sync'))?.at || 0;
}

/** Step 1: read the file from iCloud Drive and bring its changes in. */
export async function syncIn(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error('This file can’t be read. Choose “margins-sync.json”.'); }
  const remote = readDoc(data);
  const merged = mergeDocs(await storedDoc(), remote, await localDoc());
  const stats = await applyToLocal(merged);
  await remember(merged);
  return stats;
}

/** Step 2: the file to save back to iCloud Drive. */
export async function syncOutFile() {
  const merged = mergeDocs(await storedDoc(), await localDoc());
  await remember(merged);
  return new File([JSON.stringify(merged)], 'margins-sync.json', { type: 'application/json' });
}

/** After importing a book: attach any highlights that were waiting for it. */
export async function applyWaiting() {
  const doc = await storedDoc();
  if (!doc) return null;
  return applyToLocal(mergeDocs(doc, await localDoc()));
}

/** Remember a deletion so other devices delete it too. */
export async function recordDeletion(hl, book) {
  if (!book) return;
  await db.put('deleted', { id: hl.id, bookKey: bookKey(book), deletedAt: Date.now() });
}
