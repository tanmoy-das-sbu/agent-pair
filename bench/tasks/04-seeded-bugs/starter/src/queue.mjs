export class JobQueue {
  constructor(maxSize = 10) {
    this.maxSize = maxSize;
    this.items = [];
  }
  push(job, priority = 0) {
    // Seeded bug 1: off-by-one (> instead of >=)
    if (this.items.length > this.maxSize) {
      throw new Error("Queue capacity exceeded");
    }
    this.items.push({ job, priority });
    // Seeded bug 2: reverses equal-priority items instead of preserving FIFO
    this.items.sort((a, b) => (b.priority - a.priority) || 1);
  }
  pop() {
    return this.items.shift()?.job;
  }
}
