// The Mandate guard: constraints -> fast classifier -> (ambiguous) LLM judge -> atomic ledger -> adapter.
import { classify, type ClassifierState } from "./classifier.ts";
import { AtomicLedger, type Ledger } from "./ledger.ts";
import type { Constraints, Decision, MandateGuardLike, Tx } from "./types.ts";
import type { WalletAdapter } from "../adapters/wallet.ts";
import { MockWallet } from "../adapters/wallet.ts";
import { llmEnabled, llmJudge, scriptedJudge, type JudgeVerdict } from "../llm/judge.ts";

export interface GuardOptions {
  allowBelow?: number; // risk < allowBelow -> allow without escalation
  denyAbove?: number; // risk >= denyAbove -> deny without escalation
  adapter?: WalletAdapter;
  ledger?: Ledger;
  /** Override the judge (tests / DARWIN). */
  judge?: (tx: Tx, c: Constraints, cls: ReturnType<typeof classify>) => Promise<JudgeVerdict> | JudgeVerdict;
  onDecision?: (tx: Tx, d: Decision) => void;
  /** Share of each window cap available to payees not named by the user, the mandate, or history. */
  novelPayeeShare?: number;
}

export function checkConstraints(tx: Tx, c: Constraints): string[] {
  const r: string[] = [];
  const rec = tx.recipient.toLowerCase();
  if (!c.allowedKinds.includes(tx.kind)) r.push("KIND_NOT_ALLOWED");
  if (c.deniedRecipients.includes(rec)) r.push("RECIPIENT_DENIED");
  if (tx.kind === "transfer") {
    const ok = c.openRecipients || c.allowedRecipients.includes(rec) || c.allowedRecipientSuffixes.some((s) => rec.endsWith(s));
    if (!ok) r.push("RECIPIENT_NOT_ALLOWED");
  }
  if (tx.kind === "call") {
    if (!c.allowedRecipients.includes(rec)) r.push("CONTRACT_NOT_ALLOWED");
    if (!tx.method || !c.allowedMethods.includes(tx.method)) r.push("METHOD_NOT_ALLOWED");
  }
  if (tx.kind === "swap" && !c.allowedSwapPairs.some(([a, b]) => a === tx.token && b === tx.toToken)) r.push("SWAP_PAIR_NOT_ALLOWED");
  if (c.activeHoursUtc) {
    const h = new Date(tx.timestampMs).getUTCHours();
    const [s, e] = c.activeHoursUtc;
    if (!(s <= e ? h >= s && h < e : h >= s || h < e)) r.push("OUTSIDE_ACTIVE_HOURS");
  }
  if (!(tx.amount > 0) || !Number.isFinite(tx.amount)) r.push("BAD_AMOUNT");
  return r;
}

export class MandateGuard implements MandateGuardLike {
  name = "mandate";
  readonly ledger: Ledger;
  readonly adapter: WalletAdapter;
  readonly state: ClassifierState = { knownPayees: new Set(), recent: new Map() };
  stats = { allowed: 0, denied: 0, escalated: 0, llmCalls: 0 };
  private novel = new AtomicLedger();
  private novelConstraints: Constraints;
  private o: Required<Pick<GuardOptions, "allowBelow" | "denyAbove">> & GuardOptions;

  constructor(public constraints: Constraints, opts: GuardOptions = {}) {
    this.o = { allowBelow: 0.3, denyAbove: 0.75, ...opts };
    this.ledger = opts.ledger ?? new AtomicLedger();
    this.adapter = opts.adapter ?? new MockWallet();
    const share = opts.novelPayeeShare ?? 0.1;
    const scale = (r: Record<string, { windowMs: number; cap: number }[]>) =>
      Object.fromEntries(Object.entries(r).map(([k, ws]) => [k, ws.map((w) => ({ ...w, cap: Math.floor(w.cap * share) }))]));
    this.novelConstraints = { ...constraints, windows: scale(constraints.windows) };
  }

  /** The novel-payee budget: each window cap scaled by novelPayeeShare. Bounds what can go to payees nobody vouched for. */
  novelWindows() {
    return this.novelConstraints.windows;
  }

  /** A payee nobody trusted vouched for: not allow-listed, not named by the user, never paid before. */
  isNovel(tx: Tx) {
    const r = tx.recipient.toLowerCase();
    const c = this.constraints;
    return (
      tx.kind === "transfer" &&
      !c.allowedRecipients.includes(r) &&
      !c.allowedRecipientSuffixes.some((s) => r.endsWith(s)) &&
      !this.state.knownPayees.has(r) &&
      !tx.context.userInstruction.toLowerCase().includes(r)
    );
  }

  reset() {
    this.ledger.reset();
    this.novel.reset();
    this.state.knownPayees.clear();
    this.state.recent!.clear();
    this.stats = { allowed: 0, denied: 0, escalated: 0, llmCalls: 0 };
    if (this.adapter instanceof MockWallet) this.adapter.reset();
  }

  private done(tx: Tx, d: Omit<Decision, "latencyMs">, t0: number): Decision {
    const dec = { ...d, latencyMs: performance.now() - t0 };
    if (dec.verdict === "allow") this.stats.allowed++;
    else this.stats.denied++;
    this.o.onDecision?.(tx, dec);
    return dec;
  }

  async submit(tx: Tx): Promise<Decision> {
    const t0 = performance.now();
    const c = this.constraints;

    const hard = checkConstraints(tx, c);
    if (hard.length) return this.done(tx, { verdict: "deny", reasons: hard, stage: "constraints" }, t0);

    const cls = classify(tx, c, this.state);
    let stage: Decision["stage"] = "classifier";
    if (cls.risk >= this.o.denyAbove) {
      return this.done(tx, { verdict: "deny", reasons: cls.signals.map((s) => s.code), stage, risk: cls.risk }, t0);
    }
    if (cls.risk >= this.o.allowBelow) {
      this.stats.escalated++;
      let v: JudgeVerdict;
      if (this.o.judge) v = await this.o.judge(tx, c, cls);
      else if (llmEnabled()) {
        this.stats.llmCalls++;
        try {
          v = await llmJudge(tx, c, cls);
        } catch (e) {
          v = { ...scriptedJudge(tx, c, cls), reason: `llm unavailable (${(e as Error).message}); scripted` };
        }
      } else v = scriptedJudge(tx, c, cls);
      stage = v.source === "llm" ? "llm" : "classifier";
      if (!v.allow) return this.done(tx, { verdict: "deny", reasons: [`JUDGE:${v.reason}`, ...cls.signals.map((s) => s.code)], stage, risk: cls.risk }, t0);
    }

    let novelId: string | undefined;
    if (this.isNovel(tx)) {
      const nr = await this.novel.reserve(tx, this.novelConstraints);
      if (!nr.ok) return this.done(tx, { verdict: "deny", reasons: ["NOVEL_PAYEE_BUDGET", nr.reason!], stage: "ledger", risk: cls.risk }, t0);
      novelId = nr.reservationId;
    }
    const res = await this.ledger.reserve(tx, c);
    if (!res.ok) {
      if (novelId) this.novel.release(novelId);
      return this.done(tx, { verdict: "deny", reasons: [res.reason!], stage: "ledger", risk: cls.risk }, t0);
    }
    const ex = await this.adapter.execute(tx);
    if (!ex.ok) {
      if (novelId) this.novel.release(novelId);
      this.ledger.release(res.reservationId!);
      return this.done(tx, { verdict: "deny", reasons: [`ADAPTER:${ex.error}`], stage: "adapter", risk: cls.risk }, t0);
    }
    this.ledger.commit(res.reservationId!);
    const key = `${tx.recipient.toLowerCase()}|${tx.amount}`;
    this.state.recent!.set(key, [...(this.state.recent!.get(key) ?? []), tx.timestampMs]);
    if (tx.context.provenance === "user" && tx.context.userInstruction.toLowerCase().includes(tx.recipient.toLowerCase())) {
      this.state.knownPayees.add(tx.recipient.toLowerCase());
    }
    return this.done(tx, { verdict: "allow", reasons: cls.signals.map((s) => s.code), stage, risk: cls.risk, ...(novelId ? { novelBudget: true } : {}) }, t0);
  }
}
