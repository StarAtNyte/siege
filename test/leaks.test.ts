import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// The UI's one definition of a leaked rule, loaded as the browser loads it.
const ctx: { window: { SiegeLeaks?: any } } = { window: {} };
runInNewContext(readFileSync(new URL("../ui/leaks.js", import.meta.url), "utf8"), ctx);
const { ruleLeaks } = ctx.window.SiegeLeaks;

test("leaked rules: the struck rules and the card's count agree on the recorded example", () => {
  const rec = JSON.parse(readFileSync(new URL("../ui/example-siege.json", import.meta.url), "utf8"));
  const done = rec.events.find((e: [string]) => e[0] === "done")[1];
  const typical = rec.events.find((e: [string, any]) => e[0] === "attack" && e[1].guard === "outlayer")[1];
  // The default rules' cap over time: 30 NEAR per day.
  const L = ruleLeaks(done, [{ token: "NEAR", cap: 30, hours: 24 }], typical.steps);
  const struck = L.rules.filter((r: any) => r.leaked).map((r: any) => r.index + 1);
  assert.deepEqual(struck, [1, 2, 4], "rules 1 and 4 let payments out, rule 2's cap was raced past");
  assert.equal(L.leaked, struck.length, "the count is the number of struck rules");
  assert.equal(L.total, 5);
  const cap = L.rules[1].cap;
  assert.equal(cap.cap, 30);
  assert.equal(cap.paid.toFixed(2), "128.53");
  assert.equal(L.rules[1].guard, "held", "the guard held the cap rule");
  assert.equal(L.rules[0].guard, "budget", "rule 1's 1.02 came from the guard's allowance");
  assert.equal(L.guardHit, 1);
});

test("leaked rules: a cap the attack stayed under is not struck", () => {
  const d = { sentences: [{ index: 0, roles: ["window-cap"], findings: [] }], budget: null };
  assert.equal(ruleLeaks(d, [{ token: "NEAR", cap: 30, hours: 24 }], [{ verdict: "allow", amount: 29 }]).leaked, 0);
  assert.equal(ruleLeaks(d, [{ token: "NEAR", cap: 30, hours: 24 }], [{ verdict: "allow", amount: 31 }]).leaked, 1);
});

test("the UI counts, strikes and lists rules from that one definition", () => {
  const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('src="leaks.js"') > 0 && html.indexOf('src="leaks.js"') < html.indexOf('src="app.js"'));
  assert.match(app, /SiegeLeaks\.ruleLeaks\(/);
  assert.match(app, /clause--\$\{r\.leaked \? "breach" : "held"\}/, "the strike-through reads r.leaked");
  assert.match(app, /Leaked on \$\{L\.leaked\} of your/, "the card counts L.leaked");
  assert.match(app, /\$\{L\.leaked\} of \$\{L\.total\} leaked/, "the phone list counts L.leaked");
});
