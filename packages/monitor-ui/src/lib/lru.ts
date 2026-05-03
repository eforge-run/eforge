/**
 * Bounded insertion-order map — evicts the oldest entry when capacity is
 * reached. Hits do NOT promote entries (non-promoting FIFO eviction).
 * Used to cap the completed-session in-memory cache to 20 entries.
 */
export class BoundedMap<K, V> {
  private readonly cap: number;
  private readonly map: Map<K, V> = new Map();

  constructor(capacity: number) {
    this.cap = capacity;
  }

  get(key: K): V | undefined { return this.map.get(key); }

  set(key: K, value: V): void {
    if (this.map.has(key)) { this.map.set(key, value); return; }
    if (this.map.size >= this.cap) {
      this.map.delete(this.map.keys().next().value as K);
    }
    this.map.set(key, value);
  }

  has(key: K): boolean { return this.map.has(key); }

  get size(): number { return this.map.size; }
}
