// Plain-language mandate -> structured Constraints.
//
// The deterministic compiler handles a constrained English grammar so the eval runs without
// an API key. `compileWithLlm` (src/llm/compile.ts) can be layered on top for free-form text;
// its output is validated against the same schema and intersected with the rule output, so an
// LLM can only tighten a mandate, never widen it.

import { type Constraints, type TxKind, toMicro, type WindowCap } from "./types.ts";

const HOUR = 3_600_000;
const WINDOW_MS: Record<string, number> = {
  minute: 60_000,
  hour: HOUR,
  hourly: HOUR,
  day: 24 * HOUR,
  daily: 24 * HOUR,
  week: 7 * 24 * HOUR,
  weekly: 7 * 24 * HOUR,
  month: 30 * 24 * HOUR,
  monthly: 30 * 24 * HOUR,
};

const ACCOUNT_RE = /\b([a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*\.(?:testnet|near))\b/g;
const TOKEN_RE = "(NEAR|USDC|USDT|wNEAR|ETH|BTC)";

export class MandateParseError extends Error {}

export function emptyConstraints(source: string): Constraints {
  return {
    allowedRecipients: [],
    openRecipients: false,
    allowedRecipientSuffixes: [],
    deniedRecipients: [],
    perTx: {},
    windows: {},
    allowedKinds: [],
    allowedMethods: [],
    allowedSwapPairs: [],
    purposes: [],
    source,
  };
}

function addWindow(c: Constraints, token: string, w: WindowCap) {
  (c.windows[token] ??= []).push(w);
}

function normToken(t: string): string {
  return t.toUpperCase() === "WNEAR" ? "wNEAR" : t.toUpperCase();
}

/**
 * Grammar (sentences, case-insensitive, order free):
 *   "Pay up to 5 NEAR per transaction to alice.testnet and bob.testnet."
 *   "Pay any vendor invoice up to 50 USDC per transaction."           -> openRecipients
 *   "Recipients ending in .vendors.testnet are allowed."
 *   "Never pay evil.testnet."
 *   "Never spend more than 20 NEAR per day." / "at most 10 USDC per hour"
 *   "Spend at most 100 in total per week."                               -> "*" window
 *   "Only between 09:00 and 18:00 UTC."
 *   "May call deposit and withdraw on pool.testnet."
 *   "May swap NEAR to USDC up to 10 NEAR per day."
 *   "For invoices, hosting and payroll."                                 -> purposes
 */
export function compileMandate(text: string): Constraints {
  const c = emptyConstraints(text);
  const sentences = text
    .split(/(?<=[.;\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const kinds = new Set<TxKind>();

  for (const raw of sentences) {
    const s = raw.toLowerCase();

    // Denials first so "never pay x" doesn't register x as allowed.
    const neverPay = s.match(/never (?:pay|send (?:to|anything to)) (.+)/);
    if (neverPay) {
      for (const m of neverPay[1].matchAll(ACCOUNT_RE)) c.deniedRecipients.push(m[1]);
      continue;
    }

    // Time window.
    const hours = s.match(/between (\d{1,2})(?::\d{2})? and (\d{1,2})(?::\d{2})? utc/);
    if (hours) c.activeHoursUtc = [Number(hours[1]), Number(hours[2])];

    // Suffix rules.
    for (const m of s.matchAll(/ending in (\.[a-z0-9_.-]+)/g)) {
      const suf = m[1].replace(/\.$/, "");
      c.allowedRecipientSuffixes.push(suf);
      kinds.add("transfer");
    }

    // Swaps: "swap NEAR to USDC up to 10 NEAR per day"
    const swap = raw.match(new RegExp(`swap ${TOKEN_RE} (?:to|for|into) ${TOKEN_RE}`, "i"));
    if (swap) {
      kinds.add("swap");
      c.allowedSwapPairs.push([normToken(swap[1]), normToken(swap[2])]);
    }

    // Contract calls: "may call deposit and withdraw on pool.testnet"
    const call = s.match(/call ([a-z_ ,and]+?) on ([a-z0-9._-]+\.(?:testnet|near))/);
    if (call) {
      kinds.add("call");
      for (const m of call[1].split(/,|\band\b/)) {
        const name = m.trim();
        if (name) c.allowedMethods.push(name);
      }
      c.allowedRecipients.push(call[2]);
    }

    // Recipients: "to alice.testnet and bob.testnet"
    if (/\bpay\b|\bsend\b|\btransfer\b/.test(s) && !swap) {
      kinds.add("transfer");
      const accounts = [...s.matchAll(ACCOUNT_RE)].map((m) => m[1]);
      for (const a of accounts) if (!c.allowedRecipients.includes(a)) c.allowedRecipients.push(a);
      if (/\bany\b/.test(s) && /(vendor|supplier|contractor|merchant|invoice|payee)/.test(s)) {
        c.openRecipients = true;
      }
    }

    // Amount caps. Each "<n> <TOKEN>? per <window|transaction>" phrase.
    const capRe = new RegExp(
      `(?:up to|at most|no more than|more than|max(?:imum)?(?: of)?|limit(?:ed)? to)\\s+(\\d+(?:\\.\\d+)?)\\s*${TOKEN_RE}?(?:\\s+in total)?\\s+(?:per|a|an|each|every)\\s+(transaction|tx|payment|transfer|minute|hour|day|week|month)`,
      "gi",
    );
    for (const m of raw.matchAll(capRe)) {
      const amount = toMicro(Number(m[1]));
      const token = m[2] ? normToken(m[2]) : "*";
      const unit = m[3].toLowerCase();
      if (["transaction", "tx", "payment", "transfer"].includes(unit)) {
        c.perTx[token] = Math.min(c.perTx[token] ?? Infinity, amount);
      } else {
        addWindow(c, token, { windowMs: WINDOW_MS[unit], cap: amount });
      }
    }
    // "daily cap of 20 NEAR"
    const adj = raw.match(new RegExp(`(hourly|daily|weekly|monthly) (?:cap|limit|budget) (?:of )?(\\d+(?:\\.\\d+)?)\\s*${TOKEN_RE}?`, "i"));
    if (adj) {
      addWindow(c, adj[3] ? normToken(adj[3]) : "*", { windowMs: WINDOW_MS[adj[1].toLowerCase()], cap: toMicro(Number(adj[2])) });
    }

    // Purposes: "for invoices, hosting and payroll" / "purpose: ..."
    const purpose = s.match(/(?:^|\b)(?:only )?(?:for|purpose[s]?:)\s+([a-z ,/-]+?)(?:\.|$| up to| at most)/);
    if (purpose && !/per (transaction|day|hour|week|month)/.test(purpose[1])) {
      for (const p of purpose[1].split(/,|\band\b|\bor\b|\//)) {
        const w = p.trim().replace(/^(the|our|my)\s+/, "");
        if (w && w.length > 2 && !c.purposes.includes(w)) c.purposes.push(w);
      }
    }
  }

  c.allowedKinds = [...kinds];
  // A mandate that names nothing allows nothing: fail closed.
  if (c.allowedKinds.length === 0) throw new MandateParseError("it does not let the agent do anything yet. Say who it may pay and how much, for example: Pay up to 5 NEAR per transaction to alice.testnet.");
  if (c.allowedKinds.includes("transfer") && Object.keys(c.perTx).length === 0 && Object.keys(c.windows).length === 0) {
    throw new MandateParseError("it lets the agent pay but sets no limit. Add a cap, for example: up to 5 NEAR per transaction, or never more than 20 NEAR per day.");
  }
  c.deniedRecipients = [...new Set(c.deniedRecipients)];
  c.allowedRecipients = c.allowedRecipients.filter((r) => !c.deniedRecipients.includes(r));
  return c;
}

/** Intersect two constraint sets: the result allows only what both allow. Used to bound LLM output. */
export function intersect(a: Constraints, b: Constraints): Constraints {
  const minRec = (x: Record<string, number>, y: Record<string, number>) => {
    const out: Record<string, number> = { ...x };
    for (const [k, v] of Object.entries(y)) out[k] = Math.min(out[k] ?? Infinity, v);
    return out;
  };
  const windows: Record<string, { windowMs: number; cap: number }[]> = {};
  for (const src of [a.windows, b.windows])
    for (const [k, ws] of Object.entries(src)) (windows[k] ??= []).push(...ws);
  const rec = (r: string) =>
    (a.openRecipients || a.allowedRecipients.includes(r) || a.allowedRecipientSuffixes.some((s) => r.endsWith(s))) &&
    (b.openRecipients || b.allowedRecipients.includes(r) || b.allowedRecipientSuffixes.some((s) => r.endsWith(s)));
  return {
    allowedRecipients: [...new Set([...a.allowedRecipients, ...b.allowedRecipients])].filter(rec),
    openRecipients: a.openRecipients && b.openRecipients,
    allowedRecipientSuffixes: a.allowedRecipientSuffixes.filter((s) => b.openRecipients || b.allowedRecipientSuffixes.includes(s)),
    deniedRecipients: [...new Set([...a.deniedRecipients, ...b.deniedRecipients])],
    perTx: minRec(a.perTx, b.perTx),
    windows,
    activeHoursUtc: a.activeHoursUtc ?? b.activeHoursUtc,
    allowedKinds: a.allowedKinds.filter((k) => b.allowedKinds.includes(k)),
    allowedMethods: a.allowedMethods.filter((m) => b.allowedMethods.includes(m)),
    allowedSwapPairs: a.allowedSwapPairs.filter(([x, y]) => b.allowedSwapPairs.some(([p, q]) => p === x && q === y)),
    purposes: a.purposes.length ? a.purposes : b.purposes,
    source: a.source,
  };
}
