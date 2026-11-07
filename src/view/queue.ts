// Queue hands events to one consumer in order. Whatever arrives while the
// consumer is busy, such as during an animation, waits its turn.
export class Queue<T> {
  private items: T[] = [];
  private waiter: ((v: T | undefined) => void) | null = null;

  push(v: T): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(v);
    } else {
      this.items.push(v);
    }
  }

  next(): Promise<T>;
  next(timeoutMs: number): Promise<T | undefined>;
  next(timeoutMs?: number): Promise<T | undefined> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift());
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.waiter = (v) => {
        clearTimeout(timer);
        resolve(v);
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.waiter = null;
          resolve(undefined);
        }, Math.max(0, timeoutMs));
      }
    });
  }
}
