// db.js — the app's filing cabinet, stored on the device (IndexedDB).
// Three drawers: "books" (title, author, reading position…),
// "files" (the actual EPUB/PDF data) and "highlights" (text, notes, colours).

const DB_NAME = 'margins';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('highlights')) {
          const store = db.createObjectStore('highlights', { keyPath: 'id' });
          store.createIndex('bookId', 'bookId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function finished(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
  });
}

export async function getAll(store) {
  const db = await openDB();
  return request(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, key) {
  const db = await openDB();
  return request(db.transaction(store).objectStore(store).get(key));
}

export async function put(store, value) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return finished(tx);
}

export async function del(store, key) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return finished(tx);
}

export async function highlightsFor(bookId) {
  const db = await openDB();
  return request(db.transaction('highlights').objectStore('highlights').index('bookId').getAll(bookId));
}

/** Removes a book, its file and all its highlights in one go. */
export async function deleteBook(bookId) {
  const db = await openDB();
  const tx = db.transaction(['books', 'files', 'highlights'], 'readwrite');
  tx.objectStore('books').delete(bookId);
  tx.objectStore('files').delete(bookId);
  const index = tx.objectStore('highlights').index('bookId');
  index.openCursor(IDBKeyRange.only(bookId)).onsuccess = (event) => {
    const cursor = event.target.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };
  return finished(tx);
}
