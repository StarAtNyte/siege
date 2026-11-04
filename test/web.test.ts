import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { server as app } from "../src/server.ts";

const M = "Pay any vendor invoice up to 10 NEAR per transaction. At most 30 NEAR per day. Never pay mixer.testnet.";

// fetch() sets Host itself, so send a chosen Host header with node:http.
function getWithHost(base: string, host: string) {
  return new Promise<string>((resolve, reject) => {
    const u = new URL(base);
    http.get({ host: u.hostname, port: u.port, path: "/", headers: { host } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve(t));
    }).on("error", reject);
  });
}

async function listen() {
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
}

test("web app: real 404s, absolute share tags, a served og:image, and a 429 the UI can explain", async () => {
  const base = await listen();
  try {
    const page = await fetch(base + "/no/such/page");
    assert.equal(page.status, 404);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /Nothing at this address/);
    const api = await fetch(base + "/api/nope");
    assert.equal(api.status, 404);
    assert.deepEqual(await api.json(), { error: "not found" });
    assert.equal((await fetch(base + "/404.html")).status, 404, "the 404 page is not served as a 200");

    const html = await getWithHost(base, "siege.example:8080");
    assert.ok(!html.includes("__ORIGIN__"));
    assert.match(html, /<meta property="og:image" content="http:\/\/siege\.example:8080\/og\.png">/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
    const evil = await getWithHost(base, "x\"><b>").catch(() => "");
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
    app.closeAllConnections();
    await new Promise((r) => app.close(r));
  }
});

test("siege progress narrates real attacks: each play says what both guards did with it", async () => {
  const base = await listen();
  try {
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
    }
    // The plain policy pays at least one of the narrated attacks on an open mandate; the narration is not all refusals.
    assert.ok(plays.some((p) => p.verdicts.outlayer.paid));
    // The heavy genomes stay on the server.
    assert.ok(!/"genome"|"sample"/.test(txt));
  } finally {
    app.closeAllConnections();
    await new Promise((r) => app.close(r));
  }
});
