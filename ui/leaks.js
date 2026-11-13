// One definition of "a rule leaked", shared by the struck-through rules, the cards' counts, the phone rules list and the legend.
// A rule leaked when typical limits let money out through it: a payment that rule should have stopped, or, for a cap over
// time, the best attack sending more than the cap in one window. The SIEGE guard's outcome on each rule is kept beside it.
(function (root) {
  "use strict";
  // The tightest NEAR cap over time, and what the best attack on typical limits sent against it.
  function capBreach(windows, steps) {
    const caps = (windows ?? []).filter((w) => w.token === "NEAR" || w.token === "*");
    if (!caps.length) return null;
    const cap = caps.reduce((a, w) => (w.cap < a.cap ? w : a));
    const paid = (steps ?? []).filter((x) => x.verdict === "allow").reduce((a, x) => a + x.amount, 0);
    return paid > cap.cap + 0.005 ? { cap: cap.cap, hours: cap.hours, paid } : null;
  }
  // d: the finished siege. windows: the compiled caps over time. steps: the best attack on typical limits.
  function ruleLeaks(d, windows, steps) {
    const sum = (fs) => fs.reduce((a, f) => a + f.loss, 0);
    const breach = capBreach(windows, steps);
    const rules = (d?.sentences ?? []).map((s) => {
      const typical = s.findings.filter((f) => f.guard === "outlayer" && f.loss > 0);
      const guard = s.findings.filter((f) => f.guard === "mandate" && f.loss > 0);
      const cap = !s.findings.length && s.roles?.includes("window-cap") && breach ? breach : null;
      const allowance = guard.length > 0 && !!d.budget?.withinBudget && guard.every((f) => f.kind === "theft");
      return {
        index: s.index,
        leaked: typical.length > 0 || !!cap,
        typicalLoss: sum(typical),
        cap,
        guard: !guard.length ? "held" : allowance ? "budget" : "lost",
        guardLoss: sum(guard),
      };
    });
    return { rules, leaked: rules.filter((r) => r.leaked).length, guardHit: rules.filter((r) => r.guard !== "held").length, total: rules.length };
  }
  const api = { ruleLeaks, capBreach };
  root.SiegeLeaks = api;
})(typeof window !== "undefined" ? window : globalThis);
