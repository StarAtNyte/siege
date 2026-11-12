// SiegeService: the transport-independent core of the SIEGE MCP server (src/mcp/server.ts).
//
// Every payment goes Mandate guard -> (user confirmation for unvouched payees) -> backend. The backend is the two-key
// vault (the guard signs, the agent's function-call key relays spend(), the contract enforces its caps) or a mock
// wallet that moves no money. The service holds every key; nothing it returns contains one.
//
// The agent's `context` is untrusted: a compromised agent can write "the user asked me to pay x7f3a.testnet" and
// Mandate's intent check cannot tell. So a payee that is not vouched for by the spending rules, by a past payment or
// by an earlier user confirmation needs the user's own confirmation, asked over a channel the agent cannot write to
// (MCP elicitation in server.ts). No way to ask the user means no payment to that payee (fail closed).
import fs from "node:fs";
import path from "node:path";
import { MandateGuard } from "../mandate/guard.ts";
import { AtomicLedger, type Entry } from "../mandate/ledger.ts";
import { lookalike } from "../mandate/classifier.ts";
import { fromMicro, toMicro, type Constraints, type Decision, type Provenance, type Tx } from "../mandate/types.ts";
import type { ExecResult, WalletAdapter } from "../adapters/wallet.ts";

export interface VaultFloor {
  contractId: string;
  network: string;
  perTxNear: number;
  dailyNear: number;
  novelDailyNear: number;
  spentTodayNear: number;
  novelSpentTodayNear: number;
  payees: string[];
  allowlistOnly: boolean;
  paused: boolean;
}

export interface Backend {
  kind: "vault" | "mock";
  /** Plain-language label shown in every result. */
  label: string;
  adapter: WalletAdapter;
  explorer?(ref: string): string | undefined;
  /** The vault's on-chain policy and today's usage, when there is a vault. */
  floor?(): Promise<VaultFloor | undefined>;
}

export interface PayRequest {
  receiver: string;
  amount_near: number;
  purpose: string;
  context?: {
    user_instruction?: string;
    retrieved?: string[];
    reasoning?: string;
    source?: Provenance;
  };
}

export type Confirmation = "approved" | "denied" | "cancelled" | "unsupported" | "failed";
export interface ConfirmQuestion {
  receiver: string;
  amountNear: number;
  purpose: string;
  /** The trusted payee this account resembles, if any. */
  resembles?: string;
  message: string;
}
export type Confirm = (q: ConfirmQuestion) => Promise<Confirmation>;

export interface Reason {
  code: string;
  meaning: string;
}
export interface PayResult {
  status: "paid" | "denied" | "would_pay" | "needs_user_confirmation";
  receiver: string;
  amount_near: number;
  purpose: string;
  backend: { kind: Backend["kind"]; label: string };
  stage?: Decision["stage"] | "input" | "user_confirmation";
  reasons: Reason[];
  risk?: number;
  /** Whether the payee is vouched for, and by what. */
  payee: { vouched: boolean; by?: "spending rules" | "past payment" | "your earlier confirmation"; resembles?: string };
  user_confirmation: "not_needed" | Confirmation | "required";
  tx?: string;
  explorer?: string;
  next_steps?: string[];
}

const MEANING: Record<string, string> = {
  KIND_NOT_ALLOWED: "the spending rules do not allow this kind of transaction",
  RECIPIENT_DENIED: "the spending rules forbid paying this account",
  RECIPIENT_NOT_ALLOWED: "this account is not on the spending rules' list of payees",
  CONTRACT_NOT_ALLOWED: "this contract is not allowed by the spending rules",
  METHOD_NOT_ALLOWED: "this contract method is not allowed by the spending rules",
  OUTSIDE_ACTIVE_HOURS: "the spending rules only allow payments at other times of day",
  BAD_AMOUNT: "the amount is not a positive number",
  PER_TX_CAP: "the amount is above the per-transaction limit",
  NOVEL_PAYEE_BUDGET: "today's allowance for new payees is used up",
  INJECTION_SUSPECTED: "the text the agent read contains instructions aimed at the agent (prompt injection)",
  INJECTION_IN_REASONING: "the agent's reasoning repeats instructions planted in something it read",
  RECIPIENT_FROM_UNTRUSTED: "the payee comes from a document or tool output, not from the user",
  RECIPIENT_UNGROUNDED: "nothing the user said, and no past payment, mentions this payee",
  RECIPIENT_CONTRADICTS_USER: "the user named a different payee",
  ADDRESS_POISONING: "this account looks like a payee you trust but is a different account",
  NON_ASCII_RECIPIENT: "the account name contains look-alike (non-ASCII) characters",
  NON_USER_PROVENANCE: "the request did not come from the user",
  NO_FINANCIAL_INTENT: "the user's instruction does not ask for a payment",
  AMOUNT_MISMATCH: "the amount differs from what the user or the invoice said",
  PURPOSE_MISMATCH: "the purpose is outside what the spending rules allow",
  REPEATED_PAYMENT: "the same payment was made very recently (possible duplicate or drip)",
  CONFUSED_DEPUTY: "the call routes value to an account the user did not name",
  USER_DENIED: "you declined this payment when asked",
  USER_CANCELLED: "the confirmation was dismissed without approving",
  CONFIRMATION_UNSUPPORTED: "this payee needs your confirmation, and this MCP client cannot ask you (no elicitation support)",
  CONFIRMATION_FAILED: "asking you for confirmation failed, so the payment was not made",
  BAD_RECEIVER: "the receiver is not a valid NEAR account id",
  BAD_PURPOSE: "a purpose is required",
};

/** One reason per distinct meaning (the judge often repeats a classifier code). */
const uniq = (rs: Reason[]) => rs.filter((r, i) => rs.findIndex((x) => x.meaning === r.meaning) === i);

export function explain(code: string): Reason {
  if (code.startsWith("JUDGE:")) return { code: "JUDGE", meaning: `the intent check said: ${code.slice(6)}` };
  if (code.startsWith("ADAPTER:")) return { code: "BACKEND_REFUSED", meaning: `the wallet refused: ${code.slice(8)}` };
  if (code.startsWith("WINDOW_CAP_")) {
    const ms = Number(code.split("_").at(-1));
    return { code, meaning: `this would go over the ${windowName(ms)} spending limit` };
  }
  return { code, meaning: MEANING[code] ?? code.toLowerCase().replace(/_/g, " ") };
}

function windowName(ms: number) {
  const h = ms / 3_600_000;
  return h === 24 ? "daily" : h === 1 ? "hourly" : h === 168 ? "weekly" : h === 720 ? "30-day" : h >= 1 ? `${h}-hour` : `${ms / 60_000}-minute`;
}

const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/** Remove anything shaped like a private key from text that leaves the server. */
export const redact = (s: string) => s.replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/g, "ed25519:[redacted]").replace(/\b[A-Za-z0-9+/]{80,}={0,2}/g, "[redacted]");
/** One line, bounded, so agent-written text cannot fake the layout of a confirmation prompt. */
const oneLine = (s: string, n: number) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export interface ServiceOptions {
  constraints: Constraints;
  backend: Backend;
  /** Where the ledger, vouched payees and audit log persist. null = in memory only. */
  stateDir?: string | null;
  now?: () => number;
  /** Max vouched payees kept (oldest dropped first). */
  maxVouched?: number;
  guard?: ConstructorParameters<typeof MandateGuard>[1];
}

interface Vouched {
  account: string;
  by: "user" | "paid";
  at: string;
}

const DRY = "dry run: not executed";

export class SiegeService {
  readonly guard: MandateGuard;
  readonly backend: Backend;
  readonly constraints: Constraints;
  private dry = new Set<string>();
  private refs = new Map<string, string>();
  private vouched = new Map<string, Vouched>();
  private now: () => number;
  private files?: { ledger: string; vouched: string; audit: string };
  private maxVouched: number;
  private seq = 0;

  constructor(o: ServiceOptions) {
    this.constraints = o.constraints;
    this.backend = o.backend;
    this.now = o.now ?? Date.now;
    this.maxVouched = o.maxVouched ?? 256;
    const real = o.backend.adapter;
    const dry = this.dry, refs = this.refs;
    const adapter: WalletAdapter = {
      name: real.name,
      async execute(tx: Tx): Promise<ExecResult> {
        if (dry.has(tx.id)) return { ok: false, error: DRY };
        const r = await real.execute(tx);
        if (r.ok && r.ref) refs.set(tx.id, r.ref);
        return r;
      },
    };
    const ledger = new AtomicLedger();
    if (o.stateDir) {
      fs.mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
      this.files = { ledger: path.join(o.stateDir, "ledger.json"), vouched: path.join(o.stateDir, "vouched.json"), audit: path.join(o.stateDir, "audit.jsonl") };
      try {
        ledger.restore(JSON.parse(fs.readFileSync(this.files.ledger, "utf8")) as Entry[]);
      } catch {
        /* first run */
      }
      try {
        for (const v of JSON.parse(fs.readFileSync(this.files.vouched, "utf8")) as Vouched[]) if (ACCOUNT_ID.test(v.account)) this.vouched.set(v.account, v);
      } catch {
        /* first run */
      }
      const f = this.files.ledger;
      ledger.onChange = (entries) => {
        fs.writeFileSync(f + ".tmp", JSON.stringify(entries));
        fs.renameSync(f + ".tmp", f);
      };
    }
    this.guard = new MandateGuard(o.constraints, { ...o.guard, adapter, ledger });
    for (const a of this.vouched.keys()) this.guard.state.knownPayees.add(a);
  }

  /** Who vouches for this payee: the rules, a past payment, or the user. Never the agent's own context. */
  vouchedBy(account: string): PayResult["payee"]["by"] | undefined {
    const c = this.constraints;
    if (c.allowedRecipients.includes(account) || c.allowedRecipientSuffixes.some((s) => account.endsWith(s))) return "spending rules";
    const v = this.vouched.get(account);
    if (v) return v.by === "user" ? "your earlier confirmation" : "past payment";
    return undefined;
  }

  vouchedPayees() {
    return [...this.vouched.values()];
  }

  private vouch(account: string, by: Vouched["by"]) {
    const prev = this.vouched.get(account);
    if (prev && (prev.by === "user" || by === "paid")) return;
    this.vouched.delete(account);
    this.vouched.set(account, { account, by, at: new Date(this.now()).toISOString() });
    while (this.vouched.size > this.maxVouched) this.vouched.delete(this.vouched.keys().next().value!);
    this.guard.state.knownPayees.add(account);
    if (this.files) {
      fs.writeFileSync(this.files.vouched + ".tmp", JSON.stringify([...this.vouched.values()], null, 1));
      fs.renameSync(this.files.vouched + ".tmp", this.files.vouched);
    }
  }

  private audit(rec: Record<string, unknown>) {
    if (this.files) fs.appendFileSync(this.files.audit, JSON.stringify({ at: new Date(this.now()).toISOString(), ...rec }) + "\n");
  }

  /** Build a Tx from tool arguments; returns an input error instead when they are malformed. */
  toTx(r: PayRequest): Tx | PayResult {
    const receiver = String(r.receiver ?? "").trim().toLowerCase();
    const amount = Number(r.amount_near);
    const purpose = oneLine(String(r.purpose ?? ""), 140);
    const bad = (code: string): PayResult => ({ ...this.base(receiver, amount, purpose), status: "denied", stage: "input", reasons: [explain(code)], user_confirmation: "not_needed" });
    if (!ACCOUNT_ID.test(receiver) && !/^[0-9a-f]{64}$/.test(receiver)) return bad("BAD_RECEIVER");
    if (!Number.isFinite(amount) || amount <= 0 || toMicro(amount) < 1) return bad("BAD_AMOUNT");
    if (!purpose) return bad("BAD_PURPOSE");
    const ctx = r.context ?? {};
    const source: Provenance = ["user", "retrieved", "tool_output", "agent"].includes(ctx.source as string) ? (ctx.source as Provenance) : "agent";
    return {
      id: `mcp${this.now()}-${++this.seq}`, agentId: "mcp-agent", kind: "transfer", token: "NEAR", amount: toMicro(amount), recipient: receiver,
      memo: purpose, timestampMs: this.now(),
      context: {
        userInstruction: String(ctx.user_instruction ?? "").slice(0, 4000),
        retrieved: Array.isArray(ctx.retrieved) ? ctx.retrieved.slice(0, 10).map((x) => String(x).slice(0, 8000)) : [],
        reasoning: String(ctx.reasoning ?? "").slice(0, 4000),
        provenance: source,
      },
    };
  }

  private base(receiver: string, amount: number, purpose: string) {
    const by = ACCOUNT_ID.test(receiver) ? this.vouchedBy(receiver) : undefined;
    const trusted = [...this.constraints.allowedRecipients, ...this.vouched.keys()];
    const resembles = by ? undefined : lookalike(receiver, trusted);
    return {
      receiver, amount_near: amount, purpose,
      backend: { kind: this.backend.kind, label: this.backend.label },
      reasons: [] as Reason[],
      payee: { vouched: !!by, ...(by ? { by } : {}), ...(resembles ? { resembles } : {}) },
    };
  }

  private codes(d: Decision) {
    return uniq(d.reasons.filter((c) => c !== `ADAPTER:${DRY}`).map((c) => explain(redact(c))));
  }

  /** Mandate's verdict without paying and without asking the user. */
  async check(r: PayRequest): Promise<PayResult> {
    const tx = this.toTx(r);
    return "status" in tx ? tx : this.checkTx(tx);
  }

  async checkTx(tx: Tx): Promise<PayResult> {
    const b = this.base(tx.recipient, fromMicro(tx.amount), tx.memo);
    this.dry.add(tx.id);
    let d: Decision;
    try {
      d = await this.guard.submit(tx);
    } finally {
      this.dry.delete(tx.id);
    }
    const wouldAllow = d.stage === "adapter" && d.reasons.length === 1 && d.reasons[0] === `ADAPTER:${DRY}`;
    if (!wouldAllow) return { ...b, status: "denied", stage: d.stage, reasons: this.codes(d), risk: d.risk, user_confirmation: "not_needed", next_steps: nextSteps(d.reasons, b.payee) };
    const needsUser = !b.payee.vouched;
    return {
      ...b, status: needsUser ? "needs_user_confirmation" : "would_pay", stage: d.stage, reasons: this.codes(d), risk: d.risk,
      user_confirmation: needsUser ? "required" : "not_needed",
      ...(needsUser ? { next_steps: ["siege_pay will ask the user directly to confirm this new payee before paying."] } : {}),
    };
  }

  async pay(r: PayRequest, confirm: Confirm): Promise<PayResult> {
    const tx = this.toTx(r);
    return "status" in tx ? tx : this.payTx(tx, confirm);
  }

  /** Guard -> user confirmation for unvouched payees -> guard again (reserving the budget) -> backend. */
  async payTx(tx: Tx, confirm: Confirm): Promise<PayResult> {
    const pre = await this.checkTx({ ...tx, id: `${tx.id}-check` });
    if (pre.status === "denied") {
      this.audit({ tool: "siege_pay", to: tx.recipient, amountNear: fromMicro(tx.amount), verdict: "deny", stage: pre.stage, reasons: pre.reasons.map((x) => x.code) });
      return pre;
    }
    let confirmation: PayResult["user_confirmation"] = "not_needed";
    if (pre.status === "needs_user_confirmation") {
      const amountNear = fromMicro(tx.amount);
      const q: ConfirmQuestion = {
        receiver: tx.recipient, amountNear, purpose: tx.memo, resembles: pre.payee.resembles,
        message: [
          `Pay ${amountNear} NEAR to ${tx.recipient} for '${tx.memo}'?`,
          `This payee is not in your spending rules, and you have not paid or approved it before. The purpose was written by the agent.`,
          pre.payee.resembles ? `WARNING: ${tx.recipient} looks like ${pre.payee.resembles}, a payee you trust, but it is a different account.` : "",
          `Approve only if you asked for this payment. (Backend: ${this.backend.label})`,
        ].filter(Boolean).join("\n"),
      };
      let a: Confirmation;
      try {
        a = await confirm(q);
      } catch {
        a = "failed";
      }
      confirmation = a;
      if (a !== "approved") {
        const code = a === "denied" ? "USER_DENIED" : a === "cancelled" ? "USER_CANCELLED" : a === "unsupported" ? "CONFIRMATION_UNSUPPORTED" : "CONFIRMATION_FAILED";
        this.audit({ tool: "siege_pay", to: tx.recipient, amountNear, verdict: "deny", stage: "user_confirmation", confirmation: a });
        return {
          ...pre, status: "denied", stage: "user_confirmation", reasons: [explain(code)], user_confirmation: a,
          next_steps: a === "unsupported"
            ? [`Add ${tx.recipient} to the spending rules (MANDATE) if it is a payee you trust, or use an MCP client that supports elicitation (for example Claude Code) so SIEGE can ask you.`]
            : a === "denied" ? ["Nothing was paid. If this was a mistake, ask the agent to try again and approve when prompted."] : ["Nothing was paid. Ask the agent to try again if you want to approve it."],
        };
      }
      this.vouch(tx.recipient, "user");
    }
    const d = await this.guard.submit(tx);
    const b = this.base(tx.recipient, fromMicro(tx.amount), tx.memo);
    if (d.verdict !== "allow") {
      this.audit({ tool: "siege_pay", to: tx.recipient, amountNear: fromMicro(tx.amount), verdict: "deny", stage: d.stage, reasons: d.reasons, confirmation });
      return { ...b, status: "denied", stage: d.stage, reasons: this.codes(d), risk: d.risk, user_confirmation: confirmation, next_steps: nextSteps(d.reasons, b.payee) };
    }
    this.vouch(tx.recipient, "paid");
    const ref = this.refs.get(tx.id);
    this.refs.delete(tx.id);
    this.audit({ tool: "siege_pay", to: tx.recipient, amountNear: fromMicro(tx.amount), verdict: "allow", stage: d.stage, confirmation, tx: ref });
    const explorer = ref ? this.backend.explorer?.(ref) : undefined;
    return { ...b, status: "paid", stage: d.stage, reasons: this.codes(d), risk: d.risk, user_confirmation: confirmation, ...(ref ? { tx: ref } : {}), ...(explorer ? { explorer } : {}) };
  }

  /** What is left to spend: per transaction, per window (from the guard's ledger), and the vault's floor. */
  async budget() {
    const c = this.constraints, now = this.now();
    const perTx = Math.min(c.perTx.NEAR ?? Infinity, c.perTx["*"] ?? Infinity);
    const windows = [...(c.windows.NEAR ?? []).map((w) => ({ ...w, token: "NEAR" })), ...(c.windows["*"] ?? []).map((w) => ({ ...w, token: "*" }))].map((w) => {
      const spent = this.guard.ledger.spent(w.token, w.windowMs, now);
      return { window: windowName(w.windowMs), cap_near: fromMicro(w.cap), spent_near: fromMicro(spent), left_near: fromMicro(Math.max(0, w.cap - spent)) };
    });
    let floor: VaultFloor | undefined;
    let floorError: string | undefined;
    try {
      floor = await this.backend.floor?.();
    } catch (e) {
      floorError = redact(String((e as Error).message ?? e)).slice(0, 200);
    }
    const left = windows.length ? Math.min(...windows.map((w) => w.left_near)) : Infinity;
    const onChainLeft = floor ? Math.max(0, floor.dailyNear - floor.spentTodayNear) : Infinity;
    const novelLeft = floor ? (floor.allowlistOnly ? 0 : Math.max(0, floor.novelDailyNear - floor.novelSpentTodayNear)) : undefined;
    return {
      backend: { kind: this.backend.kind, label: this.backend.label },
      per_transaction_near: Number.isFinite(perTx) ? fromMicro(perTx) : null,
      windows,
      max_next_payment_near: +Math.min(Number.isFinite(perTx) ? fromMicro(perTx) : Infinity, left, floor ? Math.min(floor.perTxNear, onChainLeft) : Infinity).toFixed(6),
      new_payees: !c.openRecipients ? {
        needs_your_confirmation: false,
        on_chain_allowance_left_today_near: null,
        note: "The spending rules list their payees, so payees not on that list are refused (no confirmation can override them).",
      } : {
        needs_your_confirmation: true,
        on_chain_allowance_left_today_near: novelLeft ?? null,
        note: floor
          ? floor.allowlistOnly
            ? "The vault is allowlist-only: it pays only its listed payees, whoever approves."
            : `New payees need your confirmation first. Payees not on the vault's own list (${floor.payees.join(", ") || "none"}) also share an on-chain allowance of ${floor.novelDailyNear} NEAR per 24 h.`
          : "New payees need your confirmation first. The mock wallet has no on-chain floor.",
      },
      ...(floor ? { vault: floor } : {}),
      ...(floorError ? { vault_error: floorError } : {}),
    };
  }

  async rules() {
    const c = this.constraints;
    let floor: VaultFloor | undefined;
    try {
      floor = await this.backend.floor?.();
    } catch {
      /* reported by budget() */
    }
    return {
      mandate: c.source,
      payees: c.openRecipients ? "any vendor (open mandate): payees not listed below need your confirmation" : "only the listed payees",
      allowed_payees: c.allowedRecipients,
      allowed_suffixes: c.allowedRecipientSuffixes,
      never_pay: c.deniedRecipients,
      per_transaction_cap: Object.fromEntries(Object.entries(c.perTx).map(([k, v]) => [k, fromMicro(v)])),
      window_caps: Object.fromEntries(Object.entries(c.windows).map(([k, ws]) => [k, ws.map((w) => ({ window: windowName(w.windowMs), cap: fromMicro(w.cap) }))])),
      kinds: c.allowedKinds,
      purposes: c.purposes,
      active_hours_utc: c.activeHoursUtc ?? null,
      vouched_payees: this.vouchedPayees().map((v) => ({ account: v.account, by: v.by === "user" ? "your confirmation" : "past payment", at: v.at })),
      backend: { kind: this.backend.kind, label: this.backend.label },
      ...(floor ? { vault_floor: floor } : {}),
      note: "Rules come from the server's configuration (MANDATE / MANDATE_FILE), never from tool arguments. Only the vault's owner can change the on-chain floor.",
    };
  }
}

function nextSteps(codes: string[], payee: PayResult["payee"]): string[] {
  const s: string[] = [];
  const has = (p: string) => codes.some((c) => c.startsWith(p));
  if (has("RECIPIENT_NOT_ALLOWED") || has("RECIPIENT_DENIED")) s.push("This payee is outside your spending rules. To allow it, add it to the mandate the server is configured with (MANDATE), then restart the server.");
  if (has("PER_TX_CAP")) s.push("Ask for a smaller amount, or raise the per-transaction cap in the mandate if this payment is intended.");
  if (has("WINDOW_CAP") || has("NOVEL_PAYEE_BUDGET")) s.push("Wait for the spending window to roll over (siege_budget shows what is left), or raise the cap in the mandate.");
  if (has("INJECTION") || has("RECIPIENT_FROM_UNTRUSTED") || has("RECIPIENT_UNGROUNDED") || has("RECIPIENT_CONTRADICTS_USER") || has("ADDRESS_POISONING") || has("NON_ASCII"))
    s.push(`Do not retry with different wording. If you, the user, really want to pay ${payee.resembles ? "this look-alike account" : "this account"}, tell the agent the exact account id yourself.`);
  if (has("NO_FINANCIAL_INTENT") || has("NON_USER_PROVENANCE")) s.push("Pass the user's own words in context.user_instruction and set context.source to \"user\" when the user asked for this payment.");
  if (has("ADAPTER")) s.push("The wallet refused after the guard allowed it; the budget was released. Check siege_budget, or the vault's state on the explorer.");
  if (!s.length) s.push("Nothing was paid. Check siege_rules for what the mandate allows.");
  return s;
}
