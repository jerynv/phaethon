/**
 * A stream from one command call back to the renderer that made it, the
 * counterpart of Tauri's `Channel<T>`. Sending after the renderer went away is
 * a no-op, so a turn that outlives its window doesn't throw.
 */
export class Channel<T = unknown> {
  #closed = false;
  #onClose: Array<() => void> = [];

  readonly id: number;
  private readonly deliver: (msg: T) => boolean;
  constructor(id: number, deliver: (msg: T) => boolean) {
    this.id = id;
    this.deliver = deliver;
  }

  send(msg: T): void {
    if (this.#closed) return;
    if (!this.deliver(msg)) this.close();
  }

  get closed(): boolean {
    return this.#closed;
  }

  onClose(cb: () => void): void {
    if (this.#closed) cb();
    else this.#onClose.push(cb);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const cb of this.#onClose.splice(0)) {
      try {
        cb();
      } catch {
        // A close listener's failure must not stop the others.
      }
    }
  }
}

/** A Channel that records what it was sent; for tests and for calls made inside the core. */
export class CollectingChannel<T = unknown> extends Channel<T> {
  readonly messages: T[] = [];
  constructor(onMessage?: (msg: T) => void) {
    super(-1, (msg) => {
      this.messages.push(msg);
      onMessage?.(msg);
      return true;
    });
  }
}
