export interface QueueItem<T> { id: string; payload: T; attempts: number; createdAt: number; availableAt?: number }
export interface QueueProvider<T> {
  enqueue(item: QueueItem<T>): Promise<void>;
  dequeue(): Promise<QueueItem<T> | undefined>;
  size(): number;
}

export class MemoryQueue<T> implements QueueProvider<T> {
  private readonly items: QueueItem<T>[] = [];
  async enqueue(item: QueueItem<T>) { this.items.push(item); }
  async dequeue() {
    const now = Date.now();
    const index = this.items.findIndex((item) => (item.availableAt ?? 0) <= now);
    return index < 0 ? undefined : this.items.splice(index, 1)[0];
  }
  size() { return this.items.length; }
}
