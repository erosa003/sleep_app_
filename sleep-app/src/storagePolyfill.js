// Implementa la misma API que window.storage (get/set/delete/list) pero
// usando localStorage del navegador, para que la app funcione fuera de
// Claude, en cualquier navegador o instalada en la pantalla de inicio.
const DB_KEY = '__sleep_app_db__';

function readDb() {
  try {
    return JSON.parse(localStorage.getItem(DB_KEY) || '{}');
  } catch {
    return {};
  }
}
function writeDb(db) {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}
function nsKey(key, shared) {
  return `${shared ? 'shared' : 'personal'}:${key}`;
}

if (typeof window !== 'undefined' && !window.storage) {
  window.storage = {
    async get(key, shared = false) {
      const db = readDb();
      const k = nsKey(key, shared);
      if (!(k in db)) return null;
      return { key, value: db[k], shared };
    },
    async set(key, value, shared = false) {
      const db = readDb();
      db[nsKey(key, shared)] = value;
      writeDb(db);
      return { key, value, shared };
    },
    async delete(key, shared = false) {
      const db = readDb();
      const k = nsKey(key, shared);
      if (!(k in db)) return null;
      delete db[k];
      writeDb(db);
      return { key, deleted: true, shared };
    },
    async list(prefix = '', shared = false) {
      const db = readDb();
      const fullPrefix = nsKey(prefix, shared);
      const keys = Object.keys(db)
        .filter((k) => k.startsWith(fullPrefix))
        .map((k) => k.slice(nsKey('', shared).length));
      return { keys, prefix, shared };
    },
  };
}
