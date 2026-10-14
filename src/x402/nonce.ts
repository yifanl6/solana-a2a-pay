import { randomBytes } from 'node:crypto';

interface Entry {
  resourceKey: string;
  amount: bigint;
  expiresAt: number;
}

/**
 * Single-use payment nonces, bound to the resource and price they were quoted for.
 * In-memory: fine for one process. Use Redis (SET NX / GETDEL) for multiple instances.
 */
export class NonceStore {
  private entries = new Map<string, Entry>();

  constructor(
    private ttlMs = 120_000,
    private maxEntries = 50_000,
    private bytes = 16,
    private prefix = '',
  ) {}

  issue(resourceKey: string, amount: bigint): string {
    this.sweep();
    if (this.entries.size >= this.maxEntries) {
      // Map iterates in insertion order, so the first key is the oldest quote.
      this.entries.delete(this.entries.keys().next().value!);
    }
    const nonce = this.prefix + randomBytes(this.bytes).toString('hex');
    this.entries.set(nonce, { resourceKey, amount, expiresAt: Date.now() + this.ttlMs });
    return nonce;
  }

  /** Burns the nonce whatever the outcome. Returns an error reason, or null if it was valid. */
  consume(nonce: string, resourceKey: string, amount: bigint): string | null {
    const entry = this.entries.get(nonce);
    this.entries.delete(nonce);
    if (!entry) return 'unknown or already-used nonce';
    if (entry.expiresAt < Date.now()) return 'nonce expired';
    if (entry.resourceKey !== resourceKey) return 'nonce was issued for a different resource';
    if (entry.amount !== amount) return 'nonce was issued for a different price';
    return null;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [nonce, entry] of this.entries) {
      if (entry.expiresAt < now) this.entries.delete(nonce);
    }
  }
}
