// One command reproduces the table: `npm run eval` (or `make eval`).
// Prints a markdown table and writes results/eval.json.
import fs from "node:fs";
import { MandateGuard } from "../mandate/guard.ts";
import { OutLayerPolicyGuard } from "../baseline/outlayerPolicy.ts";
import type { MandateGuardLike, Decision } from "../mandate/types.ts";
import { fromMicro } from "../mandate/types.ts";
import { buildSuite, constraintsFor, type Case, type Category } from "./suite.ts";
import { llmEnabled, budget } from "../llm/judge.ts";

interface CaseResult {
  id: string;
  category: Category;
  blocked: boolean; // attack fully stopped (no loss) / benign: false means correctly allowed
  falsePositive: boolean;
  lossMicro: number;
  latencies: number[];
}

export async function runCase(guard: MandateGuardLike & { constraints: any }, c: Case): Promise<CaseResult> {
  guard.reset();
  for (const w of c.warmup ?? []) await guard.submit(w);
  const latencies: number[] = [];
  let loss = 0;
  let allowedTotal = 0;
  let deniedBenign = false;
  for (const step of c.steps) {
    const ds: Decision[] = await Promise.all(step.group.map((t) => guard.submit(t)));
    ds.forEach((d, k) => {
      const t = step.group[k];
      latencies.push(d.latencyMs);
      if (d.verdict === "allow") {
        allowedTotal += t.amount;
        if (c.malicious.has(t.id)) loss += t.amount;
      } else if (c.category === "benign") deniedBenign = true;
    });
  }
  if (c.capMicro !== undefined) loss += Math.max(0, allowedTotal - c.capMicro);
  return { id: c.id, category: c.category, blocked: c.category !== "benign" && loss === 0, falsePositive: deniedBenign, lossMicro: loss, latencies };
}

export async function runSuite(seed = 7, perCategory = 40) {
  const cases = buildSuite(seed, perCategory);
  const guards = {
    "OutLayer policy": (m: "whitelist" | "open") => new OutLayerPolicyGuard(constraintsFor(m)),
    Mandate: (m: "whitelist" | "open") => new MandateGuard(constraintsFor(m)),
  };
  const out: Record<string, CaseResult[]> = {};
  for (const [name, make] of Object.entries(guards)) {
    const g = { whitelist: make("whitelist"), open: make("open") };
    out[name] = [];
    for (const c of cases) out[name].push(await runCase(g[c.mandate], c));
  }
  return { cases, results: out };
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const p99 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.99))] : 0;
};

export function table(results: Record<string, CaseResult[]>) {
  const cats: Category[] = ["prompt_injection", "address_poisoning", "confused_deputy", "drip_drain", "race_cumulative_cap"];
  const names = Object.keys(results);
  const lines: string[] = [];
  lines.push(`| Attack (block rate) | ${names.join(" | ")} |`, `|---|${names.map(() => "---:").join("|")}|`);
  for (const cat of cats) {
    lines.push(`| ${cat} | ${names.map((n) => {
      const rs = results[n].filter((r) => r.category === cat);
      return pct(rs.filter((r) => r.blocked).length / rs.length);
    }).join(" | ")} |`);
  }
  const atk = (n: string) => results[n].filter((r) => r.category !== "benign");
  const ben = (n: string) => results[n].filter((r) => r.category === "benign");
  lines.push(`| **all attacks** | ${names.map((n) => `**${pct(atk(n).filter((r) => r.blocked).length / atk(n).length)}**`).join(" | ")} |`);
  lines.push(`| total value extracted (NEAR) | ${names.map((n) => fromMicro(atk(n).reduce((a, r) => a + r.lossMicro, 0)).toFixed(1)).join(" | ")} |`);
  lines.push(`| false-positive rate (benign denied) | ${names.map((n) => pct(ben(n).filter((r) => r.falsePositive).length / ben(n).length)).join(" | ")} |`);
  // The baseline's latency is a modelled gateway round trip, so only the guard's own overhead is reported.
  lines.push(`| added decision latency p50 / p99 (ms${llmEnabled() ? ", incl. LLM escalations" : ", local stages"}) | ${names.map((n) => { if (n !== "Mandate") return "baseline"; const l = results[n].flatMap((r) => r.latencies); return `${median(l).toFixed(2)} / ${p99(l).toFixed(2)}`; }).join(" | ")} |`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seed = Number(process.env.SEED ?? 7);
  const per = Number(process.env.PER ?? 40);
  const t0 = performance.now();
  const { cases, results } = await runSuite(seed, per);
  const md = table(results);
  console.log(`\nSIEGE eval  seed=${seed}  cases=${cases.length}  judge=${llmEnabled() ? "claude-haiku-5-5" : "scripted (no API key needed)"}\n`);
  console.log(md);
  console.log(`\nbaseline = OutLayer policy model (whitelist when expressible, per-tx + daily caps, best-effort counter)\nLLM spend so far: $${budget.spent().toFixed(4)}   wall time ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  fs.mkdirSync("results", { recursive: true });
  const misses = Object.fromEntries(Object.entries(results).map(([k, rs]) => [k, rs.filter((r) => (r.category === "benign" ? r.falsePositive : !r.blocked)).map((r) => r.id)]));
  fs.writeFileSync("results/eval.json", JSON.stringify({ seed, per, table: md, misses }, null, 2));
  fs.writeFileSync("results/eval.md", md + "\n");
}
