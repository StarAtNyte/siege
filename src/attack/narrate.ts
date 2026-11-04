// Turn one real attack from the search into the facts a plain-English play-by-play line needs.
// The attack is re-run against both guards, so every line says what each guard actually did with it.
import { Arena, DOC_KINDS, routedTo, type Gene, type GuardKind } from "./arena.ts";
import { fromMicro } from "../mandate/types.ts";

export type Technique = "deputy" | "lookalike" | "injection" | "document" | "direct";

export interface Play {
  round: number;
  /** The guard the search was attacking when it found this attack. */
  guard: GuardKind;
  technique: Technique;
  /** What the poisoned document posed as (invoice, injection, address-change, ...), or null when there was none. */
  lure: (typeof DOC_KINDS)[number] | null;
  to: string;
  /** For a lookalike payee: the real payee it imitates. */
  imitates: string | null;
  method: string | null;
  amount: number;
  /** Payments in the whole attack, the most fired at the same moment, and the NEAR they asked for in total. */
  payments: number;
  burst: number;
  asked: number;
  /** Many payments fired at the same moment pushed the plain policy past a cap over time. */
  raced: boolean;
  /** The theft was split into many small payments. */
  dripped: boolean;
  /** The tightest cap over time in the mandate, in NEAR, for race and drip lines. */
  cap: number | null;
  verdicts: Record<GuardKind, { paid: boolean; lost: number; reason: string | null; paidCount: number; novel: boolean }>;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export async function narrate(judge: Arena, guard: GuardKind, round: number, genome: Gene[]): Promise<Play | null> {
  if (!genome.length) return null;
  const lib = judge.lib;
  const evs = { outlayer: await judge.evaluate("outlayer", genome), mandate: await judge.evaluate("mandate", genome) };
  const txs = evs.outlayer.txs;
  const stolen = (i: number) => !lib.legit.has(routedTo(txs[i])) && routedTo(txs[i]) !== lib.contract;
  // The headline payment: the biggest one to someone the user never meant to pay, preferring one the plain policy paid.
  // An attack that sends nothing to a stranger has no story to tell, so it is skipped.
  const paidPlain = (i: number) => evs.outlayer.decisions.get(txs[i].id)?.verdict === "allow";
  const score = (i: number) => (stolen(i) ? 1 : 0) * (1 + (paidPlain(i) ? 1e6 : 0) + txs[i].amount / 1e12);
  let h = 0;
  txs.forEach((_, i) => score(i) > score(h) && (h = i));
  if (!stolen(h)) return null;
  const tx = txs[h];
  const gene = genome[h];
  const lure = gene.doc >= 0 ? DOC_KINDS[gene.doc % DOC_KINDS.length] ?? "invoice" : null;
  const to = routedTo(tx);
  let burst = 1, run = 1;
  for (let i = 1; i < txs.length; i++) burst = Math.max(burst, (run = txs[i].timestampMs === txs[i - 1].timestampMs ? run + 1 : 1));
  const thefts = txs.filter((_, i) => stolen(i));
  const overspent = evs.outlayer.breaches.some((b) => b.kind === "overspend");
  const ws = Object.values(judge.constraints.windows).flat();
  const cap = ws.length ? fromMicro(Math.min(...ws.map((w) => w.cap))) : null;
  const technique: Technique =
    tx.kind === "call" && to !== tx.recipient ? "deputy"
    : lib.imitates[to] ? "lookalike"
    : lure === "injection" ? "injection"
    : lure ? "document"
    : "direct";
  const verdict = (g: GuardKind) => {
    const d = evs[g].decisions.get(tx.id)!;
    const paidCount = txs.filter((t) => evs[g].decisions.get(t.id)?.verdict === "allow").length;
    return { paid: d.verdict === "allow", lost: round2(evs[g].loss), reason: d.verdict === "allow" ? null : d.reasons[0] ?? null, paidCount, novel: d.novelBudget };
  };
  return {
    round, guard, technique, lure, to, imitates: lib.imitates[to] ?? null, method: tx.kind === "call" ? tx.method ?? null : null,
    amount: fromMicro(tx.amount), payments: txs.length, burst, raced: burst >= 3 && overspent,
    dripped: thefts.length >= 4 && thefts.every((t) => fromMicro(t.amount) <= 2.5), asked: round2(txs.reduce((a, t) => a + fromMicro(t.amount), 0)), cap: cap == null ? null : round2(cap),
    verdicts: { outlayer: verdict("outlayer"), mandate: verdict("mandate") },
  };
}
