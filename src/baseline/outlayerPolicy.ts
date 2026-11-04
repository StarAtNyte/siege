// Model of a plain OutLayer policy (whitelist, per-transaction limit, hourly/daily/monthly caps,
// rate limit) configured from the same mandate, so the comparison is like-for-like.
// Cumulative caps are best-effort, as documented: a RacyLedger stands in for the gateway counter.
import { RacyLedger, type Ledger } from "../mandate/ledger.ts";
import type { Constraints, Decision, MandateGuardLike, Tx } from "../mandate/types.ts";
import { MockWallet, type WalletAdapter } from "../adapters/wallet.ts";
import { nearToYocto } from "../adapters/wallet.ts";
import { fromMicro } from "../mandate/types.ts";

export class OutLayerPolicyGuard implements MandateGuardLike {
  name = "outlayer-policy";
  readonly ledger: Ledger;
  readonly adapter: WalletAdapter;
  private calls: number[] = [];
  constructor(public constraints: Constraints, opts: { gapMs?: number; adapter?: WalletAdapter; maxPerHour?: number } = {}) {
    this.ledger = new RacyLedger(opts.gapMs ?? 2);
    this.adapter = opts.adapter ?? new MockWallet();
    this.maxPerHour = opts.maxPerHour ?? 60;
  }
  private maxPerHour: number;

  reset() {
    this.ledger.reset();
    this.calls = [];
    if (this.adapter instanceof MockWallet) this.adapter.reset();
  }

  async submit(tx: Tx): Promise<Decision> {
    const t0 = performance.now();
    const c = this.constraints;
    const deny = (reasons: string[]): Decision => ({ verdict: "deny", reasons, stage: "policy", latencyMs: performance.now() - t0 });
    // Address whitelist: only expressible when the mandate names recipients.
    const whitelist = !c.openRecipients && (c.allowedRecipients.length > 0 || c.allowedRecipientSuffixes.length > 0);
    const rec = tx.recipient.toLowerCase();
    if (whitelist && !(c.allowedRecipients.includes(rec) || c.allowedRecipientSuffixes.some((s) => rec.endsWith(s)))) return deny(["NOT_WHITELISTED"]);
    if (c.deniedRecipients.includes(rec)) return deny(["BLACKLISTED"]);
    // Rate limit (also best-effort, read before the await).
    const recent = this.calls.filter((t) => t > tx.timestampMs - 3_600_000).length;
    const res = await this.ledger.reserve(tx, c);
    if (recent >= this.maxPerHour) return deny(["RATE_LIMIT"]);
    if (!res.ok) return deny([res.reason!]);
    this.calls.push(tx.timestampMs);
    const ex = await this.adapter.execute(tx);
    if (!ex.ok) return deny([`ADAPTER:${ex.error}`]);
    return { verdict: "allow", reasons: [], stage: "policy", latencyMs: performance.now() - t0 };
  }
}

/** Render compiled constraints as an OutLayer policy document (same shape as their docs). */
export function toOutlayerPolicy(c: Constraints) {
  const y = (m: number) => nearToYocto(fromMicro(m));
  const limits: Record<string, Record<string, string>> = {};
  for (const [tok, cap] of Object.entries(c.perTx)) (limits.per_transaction ??= {})[tok === "NEAR" ? "native" : tok] = y(cap);
  const names: Record<number, string> = { 3_600_000: "hourly", 86_400_000: "daily", 2_592_000_000: "monthly" };
  for (const [tok, ws] of Object.entries(c.windows))
    for (const w of ws) if (names[w.windowMs]) (limits[names[w.windowMs]] ??= {})[tok === "NEAR" ? "native" : tok] = y(w.cap);
  return {
    addresses: c.openRecipients ? { mode: "none" } : { mode: "whitelist", list: [...c.allowedRecipients] },
    limits,
    rate_limit: { max_per_hour: 60 },
  };
}
