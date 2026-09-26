/**
 * Cache em memória com limite LRU (Least Recently Used).
 * Otimizado para VPS de 1 GB RAM — nunca passa de 200 itens.
 */
const MAX_ITEMS = 200;
const store = new Map();

function get(key) {
  if (!key) return null;
  const item = store.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) {
    store.delete(key);
    return null;
  }
  // Move para o fim (mais recente)
  store.delete(key);
  store.set(key, item);
  return item.value;
}

function set(key, value, ttlSeconds = 300) {
  if (!key) return;
  // Se já existe, remove pra reinserir no fim
  if (store.has(key)) store.delete(key);
  // Remove os mais antigos se atingiu o limite
  while (store.size >= MAX_ITEMS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  store.set(key, {
    value,
    expires: Date.now() + ttlSeconds * 1000,
  });
}

function del(key) {
  if (!key) return;
  store.delete(key);
}

function clear() {
  store.clear();
}

function stats() {
  return {
    size: store.size,
    maxItems: MAX_ITEMS,
  };
}

module.exports = { get, set, del, clear, stats };