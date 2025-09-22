export interface PoolStats {
  available: number;
  inUse: number;
  total: number;
}

export class ObjectPool<T> {
  private available: T[] = [];
  private readonly inUse = new Set<T>();

  constructor(
    private readonly createFn: () => T,
    private readonly resetFn: (obj: T) => void,
    initialSize = 0
  ) {
    for (let i = 0; i < initialSize; i++) {
      this.available.push(this.createFn());
    }
  }

  acquire(): T {
    const obj = this.available.pop() ?? this.createFn();
    this.inUse.add(obj);
    return obj;
  }

  release(obj: T): void {
    if (!this.inUse.has(obj)) return;
    this.inUse.delete(obj);
    this.resetFn(obj);
    this.available.push(obj);
  }

  releaseAll(): void {
    for (const obj of this.inUse) {
      this.resetFn(obj);
      this.available.push(obj);
    }
    this.inUse.clear();
  }

  getStats(): PoolStats {
    return {
      available: this.available.length,
      inUse: this.inUse.size,
      total: this.available.length + this.inUse.size
    };
  }
}
