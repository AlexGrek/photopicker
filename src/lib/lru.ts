/**
 * A small least-recently-used map. `Map` iterates in insertion order, so moving
 * a key to the end on every read keeps the first key the coldest one.
 *
 * `canEvict` lets a caller pin entries that are still in use (they are skipped,
 * so the map may temporarily exceed `limit`); `onEvict` releases whatever the
 * value holds (e.g. a blob URL).
 */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(
    private readonly limit: number,
    private readonly onEvict?: (value: V, key: K) => void,
    private readonly canEvict?: (value: V, key: K) => boolean,
  ) {}

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    this.trim();
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /** Evicts the coldest evictable entries until the map fits `limit` again. */
  trim(): void {
    if (this.map.size <= this.limit) return;
    for (const [key, value] of this.map) {
      if (this.map.size <= this.limit) break;
      if (this.canEvict && !this.canEvict(value, key)) continue;
      this.map.delete(key);
      this.onEvict?.(value, key);
    }
  }
}
