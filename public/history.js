// Previously transcribed files, kept in IndexedDB together with the audio itself so they can be
// replayed without picking the file again. Browsers never reveal a file's original path, so
// storing the audio is the only way to reopen it later.

const DB_NAME = 'playit';
const STORE = 'history';

let dbPromise = null;
const db = () =>
  (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));

const run = async (mode, fn) => {
  const tx = (await db()).transaction(STORE, mode);
  const req = fn(tx.objectStore(STORE));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
};

/** All entries, most recently played first. */
export const listHistory = async () => (await run('readonly', (s) => s.getAll())).sort((a, b) => b.playedAt - a.playedAt);
export const getEntry = (id) => run('readonly', (s) => s.get(id));
export const deleteEntry = (id) => run('readwrite', (s) => s.delete(id));

/**
 * Save an entry. `entry.audio` is the File; if storage is full the entry is kept without it,
 * and playing it asks for the file again.
 */
export async function saveEntry(entry) {
  // Ask the browser not to evict saved recordings when the device runs low on space.
  navigator.storage?.persist?.().catch(() => {});
  try {
    await run('readwrite', (s) => s.put(entry));
  } catch (e) {
    if (!entry.audio) throw e;
    await run('readwrite', (s) => s.put({ ...entry, audio: null }));
  }
}

export const touchEntry = async (id, fields) => {
  const entry = await getEntry(id);
  if (entry) await run('readwrite', (s) => s.put({ ...entry, ...fields }));
};
