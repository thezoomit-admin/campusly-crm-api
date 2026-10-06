const CATALOG_TTL_MS = 30_000;

type CatalogEntry<T> = {
  value: T;
  expiresAt: number;
};

const store = new Map<string, CatalogEntry<unknown>>();

export function getCatalogCache<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry.value as T;
}

export function setCatalogCache<T>(key: string, value: T) {
  store.set(key, { value, expiresAt: Date.now() + CATALOG_TTL_MS });
}

export function clearCatalogCache(prefix?: string) {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
    }
  }
}
