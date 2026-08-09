export class MemoryCache<T> {
  private readonly values = new Map<string, { value: T; expiresAt: number }>();
  constructor(private readonly ttlMs: number) {}
  get(key: string) {
    const item = this.values.get(key);
    if (item && item.expiresAt > Date.now()) return item.value;
    this.values.delete(key);
    return undefined;
  }
  set(key: string, value: T) { this.values.set(key, { value, expiresAt: Date.now() + this.ttlMs }); }
  clear() { this.values.clear(); }
}
