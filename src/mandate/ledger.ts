// Budget ledgers.
//
// AtomicLedger: every check-and-reserve runs inside one critical section (a promise-chain mutex),
// and reservations count against caps until they are committed or released. N concurrent requests
// therefore cannot jointly overshoot a cumulative cap, which is the gap OutLayer documents:
// "Concurrent requests can exceed these caps" because the TEE reads a usage counter supplied by the
// API gateway and keeps no state of its own.
//
// RacyLedger models that documented behaviour: read usage, await (gateway/TEE round trip), then
// check and record. Requests that overlap in the await all see the same stale usage.

import type { Constraints, Micro, Tx } from "./types.ts";

interface Entry {
  id: string;
  token: string;
  amount: Micro;
  t: number;
  state: "reserved" | "committed";
}

export interface ReserveResult {
  ok: boolean;
  reason?: string;
  reservationId?: string;
}

export interface Ledger {
  reserve(tx: Tx, c: Constraints): Promise<ReserveResult>;
  commit(id: string): void;
  release(id: string): void;
  spent(token: string, windowMs: number, now: number): Micro;
  reset(): void;
}

/** Pure cap check given current usage; shared by both ledgers so they differ only in atomicity. */
export function checkCaps(entries: Entry[], tx: Tx, c: Constraints): string | undefined {
  const per = Math.min(c.perTx[tx.token] ?? Infinity, c.perTx["*"] ?? Infinity);
  if (tx.amount > per) return "PER_TX_CAP";
  const used = (token: string | "*", windowMs: number) => {
    let s = 0;
    for (const e of entries) if ((token === "*" || e.token === token) && e.t > tx.timestampMs - windowMs) s += e.amount;
    return s;
  };
  for (const w of c.windows[tx.token] ?? []) if (used(tx.token, w.windowMs) + tx.amount > w.cap) return `WINDOW_CAP_${tx.token}_${w.windowMs}`;
  for (const w of c.windows["*"] ?? []) if (used("*", w.windowMs) + tx.amount > w.cap) return `WINDOW_CAP_ALL_${w.windowMs}`;
  return undefined;
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

let seq = 0;
const newId = () => `r${++seq}`;

export class AtomicLedger implements Ledger {
  private entries: Entry[] = [];
  private mutex = new Mutex();

  reserve(tx: Tx, c: Constraints): Promise<ReserveResult> {
    return this.mutex.run(() => {
      this.gc(tx.timestampMs);
      const reason = checkCaps(this.entries, tx, c);
      if (reason) return { ok: false, reason };
      const id = newId();
      this.entries.push({ id, token: tx.token, amount: tx.amount, t: tx.timestampMs, state: "reserved" });
      return { ok: true, reservationId: id };
    });
  }
  commit(id: string) {
    const e = this.entries.find((x) => x.id === id);
    if (e) e.state = "committed";
  }
  release(id: string) {
    this.entries = this.entries.filter((x) => x.id !== id);
  }
  spent(token: string, windowMs: number, now: number) {
    return this.entries.filter((e) => (token === "*" || e.token === token) && e.t > now - windowMs).reduce((a, e) => a + e.amount, 0);
  }
  reset() {
    this.entries = [];
  }
  private gc(now: number) {
    // Keep 31 days, the longest window the compiler emits.
    const horizon = now - 31 * 24 * 3_600_000;
    if (this.entries.length > 4096) this.entries = this.entries.filter((e) => e.t > horizon);
  }
}

/** Check-then-act with an await gap. `gapMs` stands in for the gateway -> TEE round trip. */
export class RacyLedger implements Ledger {
  private entries: Entry[] = [];
  constructor(private gapMs = 2) {}

  async reserve(tx: Tx, c: Constraints): Promise<ReserveResult> {
    const snapshot = [...this.entries]; // gateway reads the usage counter
    // TEE evaluates policy. gapMs=0 still yields to the event loop (a microtask), enough for overlap.
    if (this.gapMs > 0) await new Promise((r) => setTimeout(r, this.gapMs));
    else await null;
    const reason = checkCaps(snapshot, tx, c);
    if (reason) return { ok: false, reason };
    const id = newId();
    this.entries.push({ id, token: tx.token, amount: tx.amount, t: tx.timestampMs, state: "committed" });
    return { ok: true, reservationId: id };
  }
  commit() {}
  release(id: string) {
    this.entries = this.entries.filter((x) => x.id !== id);
  }
  spent(token: string, windowMs: number, now: number) {
    return this.entries.filter((e) => (token === "*" || e.token === token) && e.t > now - windowMs).reduce((a, e) => a + e.amount, 0);
  }
  reset() {
    this.entries = [];
  }
}
