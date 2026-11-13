import { test } from "node:test";
import assert from "node:assert/strict";
import { server as app } from "../src/server.ts";
import { serve } from "./net.ts";

const M = "Pay any vendor invoice up to 10 NEAR per transaction. At most 30 NEAR per day. Never pay mixer.testnet.";

test("web app: real 404s, absolute share tags, a served og:image, and a 429 the UI can explain", async () => {
  const { base, fetch, getWithHost, close } = await serve(app);
  try {
    const page = await fetch(base + "/no/such/page");
    assert.equal(page.status, 404);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /Nothing at this address/);
    const api = await fetch(base + "/api/nope");
    assert.equal(api.status, 404);
    assert.deepEqual(await api.json(), { error: "not found" });
    assert.equal((await fetch(base + "/404.html")).status, 404, "the 404 page is not served as a 200");

    const html = await getWithHost("/", "siege.example:8080");
    assert.ok(!html.includes("__ORIGIN__"));
    assert.match(html, /<meta property="og:image" content="http:\/\/siege\.example:8080\/og\.png">/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
    const evil = await getWithHost("/", "x\"><b>").catch(() => "");
    assert.ok(!evil.includes("x\"><b>"), "a hostile Host header is not reflected into the page");
    const og = await fetch(base + "/og.png");
    assert.equal(og.status, 200);
    assert.equal(og.headers.get("content-type"), "image/png");

    const health = await (await fetch(base + "/healthz")).json();
    assert.equal(health.maxSieges, 2);

    // Fill both siege slots, then a third is refused with 429 and a Retry-After.
    const ctl = [new AbortController(), new AbortController()];
    const url = `${base}/api/siege?generations=60&mandate=${encodeURIComponent(M)}`;
    const open = await Promise.all(ctl.map((c) => fetch(url, { signal: c.signal })));
    for (const r of open) assert.equal(r.status, 200);
    const third = await fetch(url);
    assert.equal(third.status, 429);
    assert.equal(third.headers.get("retry-after"), "5");
    assert.match((await third.json()).error, /busy/);
    ctl.forEach((c) => c.abort());
    await Promise.all(open.map((r) => r.body?.cancel().catch(() => {})));
  } finally {
    await close();
  }
});

test("siege progress narrates real attacks: each play says what both guards did with it", async () => {
  const { base, fetch, close } = await serve(app);
  try {
    // The previous test's aborted sieges free their slots once their search loop notices the disconnect.
    for (let i = 0; i < 100 && (await (await fetch(base + "/healthz")).json()).sieges > 0; i++) await new Promise((r) => setTimeout(r, 50));
    const txt = await (await fetch(`${base}/api/siege?generations=8&mandate=${encodeURIComponent(M)}`)).text();
    const plays = txt
      .split("\n\n")
      .filter((b) => b.startsWith("event: progress"))
      .map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6)).play)
      .filter(Boolean);
    assert.ok(plays.length >= 2, `expected plays, got ${plays.length}`);
    assert.ok(plays.length <= 12, "at most six lines per guard");
    for (const p of plays) {
      assert.ok(["outlayer", "mandate"].includes(p.guard));
      assert.ok(p.round >= 1 && p.round <= 8);
      assert.ok(["deputy", "lookalike", "injection", "document", "direct"].includes(p.technique));
      assert.match(p.to, /\.testnet$/);
      assert.ok(p.amount > 0 && p.payments >= 1 && p.burst >= 1);
      for (const g of ["outlayer", "mandate"]) {
        const v = p.verdicts[g];
        assert.equal(typeof v.paid, "boolean");
        assert.ok(v.paid ? v.reason === null : typeof v.reason === "string", "a refusal carries its reason");
        assert.ok(v.lost >= 0);
      }
      if (p.imitates) assert.notEqual(p.imitates, p.to);
      // Each line is tagged by its own class, never by a fixed label.
      assert.ok(Array.isArray(p.tags) && p.tags.length >= 1);
      assert.equal(p.tags[0], p.technique === "deputy" ? "deputy" : p.lure === "injection" ? "hidden" : p.lure === "address-change" ? "address" : p.lure ? "document" : "plain");
      assert.equal(p.tags.includes("lookalike"), !!p.imitates);
    }
    // The plain policy pays at least one of the narrated attacks on an open mandate; the narration is not all refusals.
    assert.ok(plays.some((p) => p.verdicts.outlayer.paid));
    // The live feed: most rounds carry one real attempt, with each guard's outcome on it.
    const attempts = txt.split("\n\n").filter((b) => b.startsWith("event: progress")).map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6)).attempt).filter(Boolean);
    assert.ok(attempts.length >= 4, `expected feed attempts, got ${attempts.length}`);
    for (const a of attempts) {
      assert.match(a.to, /\.testnet$/);
      assert.equal(typeof a.outlayer, "boolean");
      assert.ok(["refused", "allowance", "paid"].includes(a.mandate));
      assert.equal(a.tag, a.tags[0]);
    }
    // The heavy genomes stay on the server.
    assert.ok(!/"genome"|"sample"/.test(txt));
    // The done event says, per guard, how many attacks were tried and how many got nothing out.
    const done = txt.split("\n\n").find((b) => b.startsWith("event: done"))!;
    const d = JSON.parse(done.slice(done.indexOf("data: ") + 6));
    for (const g of ["outlayer", "mandate"]) {
      assert.ok(Number.isInteger(d.tried[g]) && d.tried[g] > 0);
      assert.ok(Number.isInteger(d.stopped[g]) && d.stopped[g] >= 0 && d.stopped[g] <= d.tried[g]);
    }
    assert.equal(d.tried.outlayer + d.tried.mandate, d.evaluations);
    // One accounting: the headline figure per guard is its best attack's total, the same attack the ledger lists,
    // and the per-rule figures split that same total, so no two figures on the page disagree.
    const attacks = Object.fromEntries(
      txt.split("\n\n").filter((b) => b.startsWith("event: attack")).map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6))).map((a) => [a.guard, a]),
    );
    for (const g of ["outlayer", "mandate"]) {
      assert.equal(d.losses[g], attacks[g].loss, `${g}: headline equals the best attack's total`);
      const split = [...d.sentences.flatMap((s: { findings: { guard: string; loss: number }[] }) => s.findings), ...(d.general ?? [])].filter((f) => f.guard === g).reduce((a: number, f: { loss: number }) => a + f.loss, 0);
      assert.ok(Math.abs(split - d.losses[g]) < 0.011, `${g}: rules split ${split} of ${d.losses[g]}`);
    }
  } finally {
    await close();
  }
});
