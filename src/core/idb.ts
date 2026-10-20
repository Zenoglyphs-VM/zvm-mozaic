// A key-value store in IndexedDB, for what is too big for localStorage: a
// full draft is six megabytes of bytes. One object store, opened once.

let db: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('mozaic', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('kv')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return db
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction('kv', mode).objectStore('kv'))
        req.onsuccess = () => resolve(req.result as T)
        req.onerror = () => reject(req.error)
      }),
  )
}

export const get = (key: string) => run<Uint8Array | undefined>('readonly', (s) => s.get(key)).then((v) => v ?? null)

/** An empty value deletes the key. */
export const put = (key: string, value: Uint8Array) => run<void>('readwrite', (s) => (value.length ? s.put(value, key) : s.delete(key)))
