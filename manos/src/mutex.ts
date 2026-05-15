// Per-key async mutex: all work for the same key runs serially,
// different keys run in parallel. Implemented as a Promise chain per key.
//
// Used so that two incoming WhatsApp messages from the same phone don't
// interleave their Gemini/tool calls and pollute each other's session
// state. Different phones never block each other.
//
// Memory: we hold one Promise per active phone. When a phone goes quiet,
// the chain resolves and the map entry is cleared on the next completion.

export class KeyedMutex {
  private chains = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(key) ?? Promise.resolve();
    // Chain the new work after any in-flight work. If prior rejects we still
    // want new work to proceed — swallow errors on the chain but propagate
    // errors from fn back to the caller.
    const next = prior.then(
      () => fn(),
      () => fn()
    );
    // Keep the map entry until this specific `next` settles, so concurrent
    // calls keep chaining onto the latest Promise.
    this.chains.set(key, next);
    try {
      return (await next) as T;
    } finally {
      // Clear the map entry only if it's still pointing at `next` — i.e. no
      // later caller has already replaced it with a newer Promise.
      if (this.chains.get(key) === next) {
        this.chains.delete(key);
      }
    }
  }

  size(): number {
    return this.chains.size;
  }
}
