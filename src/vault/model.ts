// A line-for-line TypeScript model of contract/src/lib.rs `spend`, for the attack arena (which runs tens of
// thousands of attacks, too many for the chain). It is pinned to the contract by contract/vectors/differential.json:
// the Rust unit tests replay those vectors against the real contract code and must get the same reason codes.
import crypto from "node:crypto";
import { approvalMessage } from "./approval.ts";
import type { Constraints } from "../mandate/types.ts";

export const HOUR_NS = 3_600_000_000_000n;
export const WINDOW_HOURS = 24n;
export const YOCTO_PER_NEAR = 10n ** 24n;
export const YOCTO_PER_MICRO = 10n ** 18n;

export interface VaultConfig {
  contractId: string;
  network: string;
  agent: string;
  /** 32 raw bytes of the registered guard key. */
  guardPk: Uint8Array;
  perTxCap: bigint;
  dailyCap: bigint;
  novelDailyCap: bigint;
  payees: string[];
  allowlistOnly: boolean;
  /** Spendable balance (the contract also keeps its storage reserve back). */
  balance: bigint;
  maxTtlNs?: bigint;
}

export interface SpendCall {
  caller: string;
  receiver: string;
  amount: bigint;
  nonce: bigint;
  expiresAt: bigint;
  /** base64; anything that is not 64 bytes is a bad signature. */
  sig: string;
  nowNs: bigint;
}

export class VaultModel {
  paused = false;
  balance: bigint;
  totalSpent = 0n;
  paid: { receiver: string; amount: bigint; novel: boolean; nowNs: bigint }[] = [];
  private used = new Set<bigint>();
  private buckets: { hour: bigint; total: bigint; novel: bigint }[] = Array.from({ length: 24 }, () => ({ hour: 0n, total: 0n, novel: 0n }));
  private pub: crypto.KeyObject;

  constructor(readonly cfg: VaultConfig) {
    this.balance = cfg.balance;
    this.pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(cfg.guardPk)]), format: "der", type: "spki" });
  }

  private window(hour: bigint) {
    let t = 0n, n = 0n;
    for (const b of this.buckets) if (b.total > 0n && b.hour <= hour && b.hour + WINDOW_HOURS > hour) { t += b.total; n += b.novel; }
    return [t, n] as const;
  }

  spend(c: SpendCall): { ok: boolean; reason?: string } {
    const r = this.check(c);
    return r === true ? { ok: true } : { ok: false, reason: r };
  }

  private check(c: SpendCall): true | string {
    const cfg = this.cfg;
    if (this.paused) return "PAUSED";
    if (c.caller !== cfg.agent) return "NOT_AGENT";
    if (c.amount === 0n) return "BAD_AMOUNT";
    let sig: Buffer;
    try {
      sig = Buffer.from(c.sig, "base64");
    } catch {
      return "BAD_SIGNATURE";
    }
    if (sig.length !== 64) return "BAD_SIGNATURE";
    let msg: string;
    try {
      msg = approvalMessage(cfg.network, cfg.contractId, { receiver: c.receiver, amount: c.amount.toString(), nonce: c.nonce.toString(), expires_at: c.expiresAt.toString() });
    } catch {
      return "BAD_SIGNATURE";
    }
    if (!crypto.verify(null, Buffer.from(msg), this.pub, sig)) return "BAD_SIGNATURE";
    if (c.nowNs >= c.expiresAt) return "APPROVAL_EXPIRED";
    if (c.expiresAt - c.nowNs > (cfg.maxTtlNs ?? HOUR_NS)) return "EXPIRY_TOO_FAR";
    if (this.used.has(c.nonce)) return "NONCE_REUSED";
    this.used.add(c.nonce);
    if (c.receiver === cfg.contractId) return "BAD_RECEIVER";
    const listed = cfg.payees.includes(c.receiver);
    if (cfg.allowlistOnly && !listed) return "RECEIVER_NOT_ALLOWED";
    if (c.amount > cfg.perTxCap) return "PER_TX_CAP";
    const hour = c.nowNs / HOUR_NS;
    const [total, novelTotal] = this.window(hour);
    if (total + c.amount > cfg.dailyCap) return "DAILY_CAP";
    const novel = !listed;
    if (novel && novelTotal + c.amount > cfg.novelDailyCap) return "NOVEL_PAYEE_BUDGET";
    if (this.balance < c.amount) return "INSUFFICIENT_BALANCE";
    const b = this.buckets[Number(hour % WINDOW_HOURS)];
    if (b.hour !== hour) Object.assign(b, { hour, total: 0n, novel: 0n });
    b.total += c.amount;
    if (novel) b.novel += c.amount;
    this.totalSpent += c.amount;
    this.balance -= c.amount;
    this.paid.push({ receiver: c.receiver, amount: c.amount, novel, nowNs: c.nowNs });
    return true;
  }
}

/**
 * The vault floor for a compiled mandate: the same per-transaction cap and 24-hour cap, the mandate's named payees
 * as the payee list, allowlist-only when the mandate names its payees, and a novel-payee budget that mirrors
 * Mandate's (share x the daily cap). Fails closed if the mandate has no NEAR daily cap.
 */
export function vaultPolicyFromMandate(c: Constraints, novelShare = 0.1) {
  const DAY = 24 * 3_600_000;
  const per = Math.min(c.perTx.NEAR ?? Infinity, c.perTx["*"] ?? Infinity);
  const day = [...(c.windows.NEAR ?? []), ...(c.windows["*"] ?? [])].filter((w) => w.windowMs <= DAY).map((w) => w.cap);
  if (!Number.isFinite(per) || !day.length) throw new Error("the vault needs a NEAR per-transaction cap and a daily cap");
  const daily = Math.min(...day);
  const toYocto = (micro: number) => BigInt(Math.round(micro)) * YOCTO_PER_MICRO;
  // Accounts the mandate only lets the agent *call* ("May call deposit_and_stake on pool.testnet") are not payees.
  const callTargets = new Set([...c.source.matchAll(/\bcall\b[^.;\n]*?\bon ([a-z0-9._-]+\.(?:testnet|near))/gi)].map((m) => m[1].toLowerCase()));
  return {
    perTxCap: toYocto(Math.min(per, daily)),
    dailyCap: toYocto(daily),
    novelDailyCap: c.openRecipients ? toYocto(Math.floor(daily * novelShare)) : 0n,
    payees: c.allowedRecipients.filter((r) => !callTargets.has(r) && !c.deniedRecipients.includes(r)),
    allowlistOnly: !c.openRecipients,
  };
}
