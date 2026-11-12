// Pin each breach the search found to the mandate sentence that allowed it, with a concrete fix.
import type { Constraints, Tx } from "../mandate/types.ts";
import { fromMicro } from "../mandate/types.ts";
import type { Breach, GuardKind } from "./arena.ts";
import { routedTo } from "./arena.ts";

export type Role = "recipients" | "open-recipients" | "cap" | "window-cap" | "calls" | "swap" | "deny" | "hours" | "purpose";

export interface Finding {
  guard: GuardKind;
  kind: "theft" | "overspend";
  loss: number;
  to: string;
  amount: number;
  how: string; // one sentence: what the attack did
  fix: string; // one sentence, an action the user can take first, then the reason after a colon
  payments?: number; // how many paid transactions this finding adds up (overspend: the payments that overshot)
}

export interface Annotated {
  index: number;
  text: string;
  roles: Role[];
  findings: Finding[];
}

export function sentences(text: string): string[] {
  return text.split(/(?<=[.;\n])\s+/).map((s) => s.trim()).filter(Boolean);
}

export function rolesOf(s: string): Role[] {
  const l = s.toLowerCase();
  const r: Role[] = [];
  if (/never (pay|send)/.test(l)) r.push("deny");
  else {
    if (/\b(pay|send|transfer)\b/.test(l) && /\bany\b/.test(l)) r.push("open-recipients");
    else if (/\b(pay|send|transfer)\b/.test(l) && /\.(testnet|near)\b/.test(l)) r.push("recipients");
    if (/\bcall\b/.test(l)) r.push("calls");
    if (/\bswap\b/.test(l)) r.push("swap");
  }
  if (/per (transaction|tx|payment|transfer)/.test(l)) r.push("cap");
  if (/(per|a|each|every) (minute|hour|day|week|month)|(hourly|daily|weekly|monthly) (cap|limit|budget)/.test(l)) r.push("window-cap");
  if (/between \d{1,2}(:\d{2})? and \d{1,2}(:\d{2})? utc/.test(l)) r.push("hours");
  if (/\bfor\b [a-z]/.test(l) && !/per (transaction|day|hour)/.test(l.split(" for ")[1] ?? "")) r.push("purpose");
  return r;
}

const SOURCE: Record<string, string> = {
  user: "the user's own request",
  retrieved: "a document the agent read",
  tool_output: "a tool's output",
  agent: "the agent's own plan",
};

function how(t: Tx, b: Breach): string {
  if (b.kind === "overspend") return `Concurrent and repeated payments went ${b.loss.toFixed(2)} NEAR past the cap.`;
  const amt = fromMicro(t.amount);
  const doc = t.context.retrieved[0];
  const src = doc ? `a document saying "${doc.split("\n")[0].slice(0, 90)}"` : SOURCE[t.context.provenance];
  if (t.kind === "call") return `A ${t.method} call on ${t.recipient} routed ${amt} NEAR to ${routedTo(t)}, prompted by ${src}.`;
  return `The agent paid ${amt} NEAR to ${t.recipient} after the user asked "${t.context.userInstruction}", prompted by ${src}.`;
}

export function diagnose(mandate: string, c: Constraints, runs: { guard: GuardKind; breaches: Breach[] }[]): { sentences: Annotated[]; general: Finding[] } {
  const ss = sentences(mandate).map((text, index) => ({ index, text, roles: rolesOf(text), findings: [] as Finding[] }));
  const general: Finding[] = [];
  // Roles in priority order: the first role any sentence carries wins.
  const find = (...roles: Role[]) => {
    for (const r of roles) {
      const hit = ss.find((s) => s.roles.includes(r));
      if (hit) return hit;
    }
    return undefined;
  };
  const novelDaily = Math.min(...(c.windows.NEAR ?? c.windows["*"] ?? []).map((w) => w.cap)) / 10;

  for (const run of runs) {
    // Every breach is attributed; findings are aggregated per sentence, guard and kind so the
    // per-sentence losses add up to the guard's total. The largest breach is the worked example.
    const groups = new Map<string, { target?: Annotated; f: Finding; count: number }>();
    for (const b of [...run.breaches].sort((x, y) => y.loss - x.loss)) {
      const t = b.tx;
      const over = b.kind === "overspend";
      let target: Annotated | undefined;
      let fix: string;
      if (over) {
        target = find("window-cap", "cap");
        fix =
          run.guard === "outlayer"
            ? "Put the Mandate guard in front of the wallet: plain policy counts spend best-effort, so concurrent requests overshoot this cap."
            : "Lower this cap, or split it per payee.";
      } else if (t.kind === "call") {
        target = find("calls");
        fix = `Name who may receive funds from ${t.recipient}, or drop ${t.method} from the mandate.`;
      } else {
        target = find("open-recipients", "recipients");
        fix = target?.roles.includes("open-recipients")
          ? run.guard === "mandate"
            ? `Name your payees, or accept that the guard lets new payees receive up to ${Number.isFinite(novelDaily) ? `${fromMicro(novelDaily).toFixed(2)} NEAR a day` : "10% of each cap"}: an invoice naming a new payee can't be told apart from a real one.`
            : "Name your payees, or put the Mandate guard in front of the wallet: an open mandate gives plain policy no list of payees to enforce."
          : `Report this to the SIEGE maintainers: ${routedTo(t)} is not one of the named payees, so it should not have passed.`;
      }
      const key = `${target?.index ?? "general"}|${b.kind}|${t.kind}`;
      const g = groups.get(key);
      if (g) {
        g.f.loss += b.loss;
        g.count++;
      } else {
        groups.set(key, { target, count: 1, f: { guard: run.guard, kind: b.kind, loss: b.loss, to: over ? "" : routedTo(t), amount: over ? b.loss : fromMicro(t.amount), how: how(t, b), fix } });
      }
    }
    for (const { target, f, count } of groups.values()) {
      if (count > 1) f.how += ` ${count - 1} more like it in the same attack.`;
      f.payments = count;
      f.loss = Math.round(f.loss * 100) / 100;
      (target ?? { findings: general }).findings.push(f);
    }
  }
  if (!Object.keys(c.windows).length) {
    general.push({ guard: "mandate", kind: "overspend", loss: 0, to: "", amount: 0, how: "The mandate has a per-transaction cap but no cap over time.", fix: "Add a sentence like \"Never spend more than 20 NEAR per day.\"" });
  }
  return { sentences: ss, general };
}
