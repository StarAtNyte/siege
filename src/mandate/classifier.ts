// Fast local semantic check (no network, ~0.1 ms). Scores a transaction against the mandate and
// its context for the attack classes a static policy cannot see: prompt injection, address
// poisoning, confused deputy, purpose drift and amount drift. Clear cases are decided here;
// the ambiguous band escalates to the LLM judge.

import type { Constraints, Tx } from "./types.ts";
import { fromMicro } from "./types.ts";

export interface Signal {
  code: string;
  weight: number;
  detail: string;
}

export interface ClassifierResult {
  risk: number; // 0..1
  signals: Signal[];
}

const ACCOUNT_RE = /[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*\.(?:testnet|near)\b/g;

const INJECTION_PATTERNS: [RegExp, number, string][] = [
  [/ignore (all |any )?(previous|prior|above|earlier) (instructions|rules|messages)/i, 0.9, "override phrase"],
  [/disregard (the |your )?(mandate|policy|rules|instructions)/i, 0.9, "override phrase"],
  [/\b(system|developer|admin)\s*(prompt|message|override|notice)\s*:/i, 0.7, "fake authority header"],
  [/\byou (are|must|should|will) now\b/i, 0.5, "role reassignment"],
  [/\b(as an? (ai|assistant|agent))\b.*\b(send|transfer|pay)\b/i, 0.6, "addresses the agent"],
  [/\b(new|updated|changed) (payment|wallet|bank|deposit|receiving) (address|account|details)\b/i, 0.7, "payment address change"],
  [/\b(payment |wallet |receiving |bank )?(address|account|details) (has |have )?(been )?(changed|moved|updated)\b/i, 0.7, "payment address change"],
  [/\b(urgent|immediately|right now|asap|final notice|or (your )?account will be)\b/i, 0.25, "urgency pressure"],
  [/\b(do not|don't) (tell|inform|notify|ask) (the )?(user|owner|human)\b/i, 0.9, "secrecy request"],
  [/\b(send|transfer|pay|forward)\b[^\n]{0,60}?\b(all|entire|remaining|full) (balance|funds)\b/i, 0.8, "drain request"],
  [/<\/?(system|instructions?|tool)>/i, 0.6, "markup injection"],
  [/\b(repeat|retry|keep (sending|paying))\b[^\n]{0,60}?\b(until|charge|payment|transfer)\b/i, 0.6, "repetition loop"],
];

const HOMOGLYPHS: Record<string, string> = { "0": "o", "1": "l", "3": "e", "5": "s", "rn": "m", "vv": "w", "ı": "i", "о": "o", "а": "a", "е": "e" };

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

function skeleton(s: string): string {
  let out = s.normalize("NFKC").toLowerCase();
  for (const [k, v] of Object.entries(HOMOGLYPHS)) out = out.split(k).join(v);
  return out;
}

/** Is `candidate` a lookalike of a trusted account without being it? */
export function lookalike(candidate: string, trusted: Iterable<string>): string | undefined {
  const cs = skeleton(candidate);
  for (const t of trusted) {
    if (t === candidate) return undefined;
  }
  for (const t of trusted) {
    const ts = skeleton(t);
    if (cs === ts) return t; // homoglyph swap
    // Embedding: "bob.testnet.attacker.testnet", "cloudhost-invoices.testnet" (finding 001).
    const tb = ts.replace(/\.(testnet|near)$/, "");
    if (tb.length >= 4 && cs.includes(tb)) return t;
    const d = levenshtein(candidate, t);
    if (d > 0 && d <= Math.max(2, Math.floor(t.length / 6))) return t;
    // Prefix/suffix poisoning: same first 4 and last 4 characters (the part UIs show).
    const ca = candidate.replace(/\.(testnet|near)$/, ""), ta = t.replace(/\.(testnet|near)$/, "");
    if (ca.length >= 8 && ta.length >= 8 && ca.slice(0, 4) === ta.slice(0, 4) && ca.slice(-4) === ta.slice(-4)) return t;
  }
  return undefined;
}

const STOP = new Set(["the", "a", "an", "for", "to", "of", "and", "or", "our", "my", "this", "that", "on", "in", "with", "pay", "payment", "send"]);
const stem = (w: string) => w.replace(/(ing|ed|s)$/, "").replace(/e$/, ""); // invoices, invoice -> invoic
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem));

function accountsIn(text: string): string[] {
  return [...text.toLowerCase().matchAll(ACCOUNT_RE)].map((m) => m[0]);
}

function argAccounts(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(...accountsIn(v));
  else if (Array.isArray(v)) v.forEach((x) => argAccounts(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => argAccounts(x, out));
  return out;
}

function numbersIn(text: string): number[] {
  return [...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:near|usdc|usdt|wnear|n\b)/gi)].map((m) => Number(m[1]));
}

export interface ClassifierState {
  /** Recipients previously paid on direct user instruction. */
  knownPayees: Set<string>;
  /** Recent allowed transactions (recipient|amount -> timestamps) for velocity checks. */
  recent?: Map<string, number[]>;
}

export function classify(tx: Tx, c: Constraints, st: ClassifierState): ClassifierResult {
  const sig: Signal[] = [];
  const add = (code: string, weight: number, detail: string) => sig.push({ code, weight, detail });
  const ctx = tx.context;
  const retrieved = ctx.retrieved.join("\n");
  const user = ctx.userInstruction.toLowerCase();
  const recipient = tx.recipient.toLowerCase();

  // 1. Injection markers in untrusted content, and in the agent's own reasoning (laundered injection).
  for (const [re, w, why] of INJECTION_PATTERNS) {
    if (re.test(retrieved)) add("INJECTION_SUSPECTED", w, `retrieved content: ${why}`);
    if (re.test(ctx.reasoning)) add("INJECTION_IN_REASONING", w * 0.8, `agent reasoning: ${why}`);
  }

  // 2. Grounding: did the principal name this recipient? Is it trusted by the mandate?
  const inAllow = c.allowedRecipients.includes(recipient) || c.allowedRecipientSuffixes.some((s) => recipient.endsWith(s));
  const inUser = user.includes(recipient);
  const inRetrieved = retrieved.toLowerCase().includes(recipient);
  const known = st.knownPayees.has(recipient);
  if (!inAllow && !inUser && !known) {
    if (inRetrieved) add("RECIPIENT_FROM_UNTRUSTED", 0.35, "recipient only appears in retrieved content");
    else add("RECIPIENT_UNGROUNDED", 0.55, "recipient appears nowhere in the user request or mandate");
  }
  // The principal named a payee and this is someone else (found by the attack engine, finding 001).
  const userNamed = accountsIn(user).filter((a) => a !== "pool.testnet");
  if (tx.kind === "transfer" && userNamed.length && !userNamed.includes(recipient) && !inAllow) {
    add("RECIPIENT_CONTRADICTS_USER", 0.8, `user named ${userNamed.join(", ")}`);
  }
  if (ctx.provenance !== "user" && !inUser) add("NON_USER_PROVENANCE", 0.15, `triggered by ${ctx.provenance}`);

  // 3. Address poisoning.
  // References for lookalike checks include accounts named in the same retrieved document
  // ("Statement for cloudhost.testnet ... processed by c1oudhost.testnet", finding 003).
  const trusted = new Set([...c.allowedRecipients, ...st.knownPayees, ...accountsIn(user), ...accountsIn(retrieved).filter((a) => a !== recipient)]);
  const look = lookalike(recipient, trusted);
  if (look) add("ADDRESS_POISONING", 0.95, `${recipient} imitates ${look}`);
  if (/[^\x00-\x7f]/.test(tx.recipient)) add("NON_ASCII_RECIPIENT", 0.9, "non-ASCII characters in account id");

  // 4. Confused deputy: allowed contract + allowed method, but the args route value to someone else.
  if (tx.kind === "call" && tx.args) {
    const user_accounts = new Set([...accountsIn(user), ...c.allowedRecipients, ...st.knownPayees, tx.agentId]);
    for (const a of argAccounts(tx.args)) {
      if (a !== tx.recipient && !user_accounts.has(a)) add("CONFUSED_DEPUTY", 0.8, `call args route to ungrounded account ${a}`);
    }
  }

  // 5. Amount drift: the user named an amount and this is not it.
  const stated = numbersIn(user);
  const amt = fromMicro(tx.amount);
  if (stated.length && !stated.some((n) => Math.abs(n - amt) < 1e-9)) {
    add("AMOUNT_MISMATCH", stated.every((n) => amt > n) ? 0.6 : 0.2, `user said ${stated.join("/")}, tx is ${amt}`);
  }

  // 6. Purpose drift.
  if (c.purposes.length) {
    const purposeWords = new Set(c.purposes.flatMap((p) => [...words(p)]));
    const txWords = words(`${tx.memo} ${ctx.reasoning} ${ctx.userInstruction}`);
    const overlap = [...txWords].some((w) => purposeWords.has(w));
    if (!overlap) add("PURPOSE_MISMATCH", 0.3, `no overlap with purposes: ${c.purposes.join(", ")}`);
  }

  // 7. User explicitly asked for nothing financial.
  if (!/\b(pay|send|transfer|swap|tip|refund|settle|deposit|withdraw|stake|buy|invoice|bill|fund|top up|renew|subscription|purchase|order|reimburse)/.test(user)) {
    add("NO_FINANCIAL_INTENT", 0.5, "user request contains no payment intent");
  }

  // 8. Velocity: the same payment repeated without the user asking for a count.
  const key = `${recipient}|${tx.amount}`;
  const prior = (st.recent?.get(key) ?? []).filter((t) => t > tx.timestampMs - 86_400_000).length;
  const askedForMany = /\b(all|each|every|\d+ (times|payments|invoices))\b/.test(user);
  if (prior >= 1 && !askedForMany) add("REPEATED_PAYMENT", prior >= 2 ? 0.7 : 0.35, `${prior} identical payments in 24h`);

  // Noisy-OR combination: independent pieces of evidence compound.
  const risk = 1 - sig.reduce((p, s) => p * (1 - Math.min(0.99, s.weight)), 1);
  return { risk, signals: sig };
}
