// Replay a counterexample found by the attack engine against both guards, with full decisions.
// usage: node --import tsx src/replay.ts results/attack_outlayer_open.json
import fs from "node:fs";
import { evaluate } from "./oracle.ts";
const file = process.argv[2];
const ce = JSON.parse(fs.readFileSync(file, "utf8"));
for (const guard of ["outlayer", "mandate"]) {
  const r = await evaluate(guard, ce.mandate, ce.best.genome);
  console.log(`\n== ${guard} (${ce.mandate} mandate): loss ${r.loss} NEAR, ${r.allowed.length}/${r.txs.length} allowed`);
  for (const t of r.txs) {
    const d = r.decisions.find((x) => x.id === t.id)!;
    console.log(`  ${d.verdict.padEnd(5)} ${t.kind} ${t.amount / 1e6} NEAR -> ${t.recipient}${t.args ? " " + JSON.stringify(t.args) : ""}  ${d.verdict === "deny" ? d.reasons.slice(0, 3).join(",") : ""}`);
  }
}
