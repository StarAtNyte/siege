// Borsh encoding for the vault contract's arguments and results (contract/src/lib.rs takes Borsh, not JSON,
// which keeps serde_json out of the wasm). Only the handful of types the vault uses.
import { unbase58 } from "./approval.ts";

export class W {
  private parts: Buffer[] = [];
  u8(n: number) { this.parts.push(Buffer.from([n])); return this; }
  bool(b: boolean) { return this.u8(b ? 1 : 0); }
  u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n); this.parts.push(b); return this; }
  u64(n: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt.asUintN(64, n)); this.parts.push(b); return this; }
  u128(n: bigint) { if (n < 0n || n >= 1n << 128n) throw new Error("u128 out of range"); const b = Buffer.alloc(16); b.writeBigUInt64LE(n & ((1n << 64n) - 1n)); b.writeBigUInt64LE(n >> 64n, 8); this.parts.push(b); return this; }
  bytes(x: Uint8Array) { this.u32(x.length); this.parts.push(Buffer.from(x)); return this; }
  str(s: string) { return this.bytes(Buffer.from(s, "utf8")); }
  strs(xs: string[]) { this.u32(xs.length); for (const s of xs) this.str(s); return this; }
  optU64(n?: bigint) { return n === undefined ? this.u8(0) : this.u8(1).u64(n); }
  /** near_sdk::PublicKey: Vec<u8> of curve byte (0 = ed25519) + 32 key bytes. */
  pk(near: string) { const raw = unbase58(near.replace(/^ed25519:/, "")); if (raw.length !== 32) throw new Error("ed25519 public key expected"); return this.bytes(Buffer.concat([Buffer.from([0]), raw])); }
  done(): Uint8Array { return new Uint8Array(Buffer.concat(this.parts)); }
}

export class R {
  private o = 0;
  constructor(private b: Buffer) {}
  u8() { return this.b[this.o++]; }
  bool() { return this.u8() === 1; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  u128() { const lo = this.b.readBigUInt64LE(this.o), hi = this.b.readBigUInt64LE(this.o + 8); this.o += 16; return lo + (hi << 64n); }
  bytes() { const n = this.u32(); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  str() { return this.bytes().toString("utf8"); }
  strs() { return Array.from({ length: this.u32() }, () => this.str()); }
}

export interface VaultInit {
  owner: string;
  agent: string;
  guardPk: string;
  network: string;
  perTxCap: bigint;
  dailyCap: bigint;
  novelDailyCap: bigint;
  payees: string[];
  allowlistOnly: boolean;
}

export const encodeInit = (v: VaultInit) =>
  new W().str(v.owner).str(v.agent).pk(v.guardPk).str(v.network).u128(v.perTxCap).u128(v.dailyCap).u128(v.novelDailyCap).strs(v.payees).bool(v.allowlistOnly).done();

export const encodeSpend = (a: { receiver: string; amount: string; nonce: string; expires_at: string; guard_sig: string }) =>
  new W().str(a.receiver).u128(BigInt(a.amount)).u64(BigInt(a.nonce)).u64(BigInt(a.expires_at)).bytes(Buffer.from(a.guard_sig, "base64")).done();

export const encodeSetPolicy = (perTx: bigint, daily: bigint, novel: bigint, maxTtlSecs?: bigint) => new W().u128(perTx).u128(daily).u128(novel).optU64(maxTtlSecs).done();
export const encodeU64 = (n: bigint) => new W().u64(n).done();

export function decodeSpendOutcome(b: Uint8Array): { ok: boolean; reason?: string } {
  const r = new R(Buffer.from(b));
  const ok = r.bool();
  return r.u8() === 1 ? { ok, reason: r.str() } : { ok };
}

export function decodeStats(b: Uint8Array) {
  const r = new R(Buffer.from(b));
  return { totalSpent: r.u128(), spends: r.u64(), refusals: r.u64(), windowSpent: r.u128(), windowNovelSpent: r.u128() };
}

export function decodePolicy(b: Uint8Array) {
  const r = new R(Buffer.from(b));
  return {
    owner: r.str(), agent: r.str(), guardPk: r.bytes(), network: r.str(), perTxCap: r.u128(), dailyCap: r.u128(), novelDailyCap: r.u128(),
    payees: r.strs(), allowlistOnly: r.bool(), paused: r.bool(), maxTtlSecs: r.u64(),
  };
}
