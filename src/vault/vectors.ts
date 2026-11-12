// Differential vectors pinning the TypeScript VaultModel to the Rust contract.
// `node --import tsx src/vault/vectors.ts` rewrites contract/vectors/differential.json from the model; the Rust unit test
// `differential_vectors_match_ts_model` replays every step against the real contract code and must get the same
// outcome, and test/vault.test.ts checks the model still reproduces the file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GuardSigner } from "./approval.ts";
import { VaultModel, YOCTO_PER_NEAR } from "./model.ts";

export const VECTORS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../contract/vectors/differential.json");
export const VECTOR_CONFIG = { contractId: "vault.testnet", network: "testnet", agent: "vault.testnet", perTxNear: 5, dailyNear: 20, novelNear: 2, payees: ["alice.testnet", "bob.testnet"] };
const T0 = 1_800_000_000_000_000_000n;

export interface Step { caller: string; receiver: string; amount: string; nonce: string; expires_at: string; sig: string; now: string; expect: string | null }

export function modelFor() {
  const g = new GuardSigner(new Uint8Array(32).fill(7));
  const c = VECTOR_CONFIG;
  return {
    guard: g,
    model: new VaultModel({
      contractId: c.contractId, network: c.network, agent: c.agent, guardPk: g.publicKeyBytes, perTxCap: BigInt(c.perTxNear) * YOCTO_PER_NEAR,
      dailyCap: BigInt(c.dailyNear) * YOCTO_PER_NEAR, novelDailyCap: BigInt(c.novelNear) * YOCTO_PER_NEAR, payees: c.payees, allowlistOnly: false, balance: 900n * YOCTO_PER_NEAR,
    }),
  };
}

export function replay(steps: Step[]) {
  const { model } = modelFor();
  return steps.map((s) => model.spend({ caller: s.caller, receiver: s.receiver, amount: BigInt(s.amount), nonce: BigInt(s.nonce), expiresAt: BigInt(s.expires_at), sig: s.sig, nowNs: BigInt(s.now) }).reason ?? null);
}

export function generate(n = 240, seed = 20261114): Step[] {
  const { guard, model } = modelFor();
  const forger = new GuardSigner(new Uint8Array(32).fill(13));
  let s = seed >>> 0;
  const r = () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const recv = ["alice.testnet", "bob.testnet", "alice.testnet", "bob.testnet", "mallory.testnet", "x7f3a.testnet", "mallory.testnet", "vault.testnet"];
  const steps: Step[] = [];
  const genuine: Step[] = [];
  let now = T0, nonce = 0n;
  for (let i = 0; i < n; i++) {
    now += BigInt(Math.floor(r() * (r() < 0.75 ? 600 : 3 * 3600))) * 1_000_000_000n;
    const receiver = pick(recv);
    const amount = (BigInt(1 + Math.floor(r() * 70)) * YOCTO_PER_NEAR) / 10n;
    const ttl = BigInt(1 + Math.floor(r() * 4000)) * 1_000_000_000n; // up to 4000 s: a few exceed the 1 h max
    const kind = r();
    let st: Step;
    const sign = (who: GuardSigner, to: string, amt: bigint, nn: bigint, exp: bigint, net = "testnet", cid = "vault.testnet") =>
      who.approve(net, cid, { receiver: to, amount: amt.toString(), nonce: nn.toString(), expires_at: exp.toString() }).guard_sig;
    const mk = (o: { caller?: string; amount: bigint; nonce: bigint; exp: bigint; sig: string; receiver: string }): Step =>
      ({ caller: o.caller ?? "vault.testnet", receiver: o.receiver, amount: o.amount.toString(), nonce: o.nonce.toString(), expires_at: o.exp.toString(), sig: o.sig, now: now.toString(), expect: null });
    if (kind < 0.45 || !genuine.length) {
      nonce++;
      st = mk({ receiver, amount, nonce, exp: now + ttl, sig: sign(guard, receiver, amount, nonce, now + ttl) });
      genuine.push(st);
    } else if (kind < 0.55) {
      nonce++;
      st = mk({ receiver, amount, nonce, exp: now + ttl, sig: sign(forger, receiver, amount, nonce, now + ttl) });
    } else if (kind < 0.65) {
      const g = r() < 0.6 ? genuine[genuine.length - 1] : pick(genuine);
      st = { ...g, now: now.toString(), expect: null }; // replay, maybe expired
    } else if (kind < 0.72) {
      const g = pick(genuine);
      st = { ...g, receiver: "mallory.testnet", now: now.toString(), expect: null }; // retarget a genuine signature
    } else if (kind < 0.78) {
      nonce++;
      st = mk({ receiver, amount, nonce, exp: now + ttl, sig: sign(guard, receiver, amount, nonce, now + ttl, "mainnet") });
    } else if (kind < 0.83) {
      nonce++;
      st = mk({ receiver, amount, nonce, exp: now + ttl, sig: sign(guard, receiver, amount, nonce, now + ttl), caller: "mallory.testnet" });
    } else if (kind < 0.88) {
      nonce++;
      st = mk({ receiver, amount, nonce, exp: now + ttl, sig: "" });
    } else if (kind < 0.93) {
      nonce++;
      const past = now - BigInt(1 + Math.floor(r() * 3600)) * 1_000_000_000n;
      st = mk({ receiver, amount, nonce, exp: past, sig: sign(guard, receiver, amount, nonce, past) });
    } else {
      nonce++;
      const big = amount * 3n; // over the per-tx cap, genuinely signed
      st = mk({ receiver, amount: big, nonce, exp: now + ttl, sig: sign(guard, receiver, big, nonce, now + ttl) });
      genuine.push(st);
    }
    st.expect = model.spend({ caller: st.caller, receiver: st.receiver, amount: BigInt(st.amount), nonce: BigInt(st.nonce), expiresAt: BigInt(st.expires_at), sig: st.sig, nowNs: BigInt(st.now) }).reason ?? null;
    steps.push(st);
  }
  return steps;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const steps = generate();
  fs.mkdirSync(path.dirname(VECTORS), { recursive: true });
  fs.writeFileSync(VECTORS, JSON.stringify({ config: VECTOR_CONFIG, guard_seed_byte: 7, steps }, null, 1) + "\n");
  const tally: Record<string, number> = {};
  for (const s of steps) tally[s.expect ?? "PAID"] = (tally[s.expect ?? "PAID"] ?? 0) + 1;
  console.log(`wrote ${steps.length} steps to ${path.relative(process.cwd(), VECTORS)}`, tally);
}
