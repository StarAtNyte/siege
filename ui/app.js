// SIEGE web UI: compile as you type, lay siege over SSE, red-line the mandate, try a transaction, export.
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const near = (n) => Number(n).toFixed(2);
  const GUARD = { outlayer: "Plain OutLayer policy", mandate: "Mandate guard" };
  const SHORT = { outlayer: "Plain policy", mandate: "Mandate guard" };
  const GENERATIONS = 30;

  const ta = $("#mandate");
  const status = $("#doc-status");
  const siegeBtn = $("#siege-btn");
  const editBtn = $("#edit-btn");
  const clausesEl = $("#clauses");
  const generalEl = $("#general");
  const siegeEl = $("#siege");
  const stateEl = $("#siege-state");

  let compiled = null; // last good compile response
  let compileOk = false;
  let compileSeq = 0;
  let es = null;
  let legit = new Set();

  // ---------- helpers ----------
  const human = (code) => {
    const s = String(code).replace(/^JUDGE:/, "judge: ").replace(/_/g, " ").toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  const list = (xs) => (xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs.at(-1));
  const monoList = (xs) => {
    const f = document.createDocumentFragment();
    xs.forEach((x, i) => {
      if (i) f.append(i === xs.length - 1 ? " and " : ", ");
      f.append(el("span", { class: "mono", text: x }));
    });
    return f;
  };
  const hours = (h) => (h === 24 ? "per day" : h === 1 ? "per hour" : h === 168 ? "per week" : h % 24 === 0 ? `per ${h / 24} days` : `per ${h} hours`);

  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  // Render an account id in mono, marking the characters that differ from the real payee it imitates.
  function account(id) {
    const span = el("span");
    if (!id) return span;
    let best = null, bd = Infinity;
    for (const l of legit) {
      if (l === id) return span.append(id), span;
      const name = l.split(".")[0];
      const dd = id.includes(name) ? 1 : lev(id, l);
      if (dd < bd) (bd = dd), (best = l);
    }
    if (!best || bd > 2) return span.append(id), span;
    let p = 0;
    while (p < id.length && p < best.length && id[p] === best[p]) p++;
    let s = 0;
    while (s < id.length - p && s < best.length - p && id[id.length - 1 - s] === best[best.length - 1 - s]) s++;
    span.append(id.slice(0, p), el("mark", { text: id.slice(p, id.length - s), title: `imitates ${best}` }), id.slice(id.length - s));
    return span;
  }

  // ---------- compile ----------
  async function compile() {
    const text = ta.value;
    const seq = ++compileSeq;
    if (!text.trim()) return showCompileError("Write a mandate first. Say who the agent may pay, how much per transaction, and how much per day.");
    $(".reading").setAttribute("aria-busy", "true");
    status.dataset.tone = "";
    status.textContent = "Reading the mandate…";
    try {
      const r = await fetch("/api/compile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mandate: text }) });
      if (seq !== compileSeq) return;
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return showCompileError(r.status === 422 ? `This mandate does not compile: ${j.error}.` : j.error || `The server answered ${r.status}.`);
      compiled = j;
      compileOk = true;
      ta.removeAttribute("aria-invalid");
      status.textContent = "";
      siegeBtn.removeAttribute("aria-disabled");
      renderReading(j.constraints);
      renderExport(j, text);
    } catch {
      if (seq !== compileSeq) return;
      showCompileError("Can't reach the SIEGE server. Start it with npm start, then edit the mandate to retry.");
    } finally {
      if (seq === compileSeq) $(".reading").removeAttribute("aria-busy");
    }
  }
  function showCompileError(msg) {
    compileOk = false;
    ta.setAttribute("aria-invalid", "true");
    status.dataset.tone = "error";
    status.textContent = msg;
    siegeBtn.setAttribute("aria-disabled", "true");
    $(".reading").removeAttribute("aria-busy");
  }
  let debounce;
  ta.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(compile, 400);
  });

  function renderReading(c) {
    const dl = $("#reading");
    dl.replaceChildren();
    const row = (k, v) => dl.append(el("div", { class: "reading__row" }, el("dt", { text: k }), el("dd", {}, v)));
    row("May pay", typeof c.payees === "string" ? c.payees.charAt(0).toUpperCase() + c.payees.slice(1) : c.payees.length ? monoList(c.payees) : "Nobody by transfer");
    if (c.suffixes?.length) row("Also any account under", monoList(c.suffixes));
    if (c.denied?.length) row("Never pays", monoList(c.denied));
    const per = Object.entries(c.perTransaction || {});
    row("Per transaction", per.length ? per.map(([t, v]) => `${v} ${t === "*" ? "of any token" : t}`).join(", ") : "No cap");
    row("Over time", c.windows?.length ? c.windows.map((w) => `${w.cap} ${w.token === "*" ? "of any token" : w.token} ${hours(w.hours)}`).join(", ") : "No cap over time");
    row("Kinds", c.kinds.length ? list(c.kinds.map((k) => (k === "call" ? "contract calls" : k === "transfer" ? "transfers" : k + "s"))).replace(/^./, (x) => x.toUpperCase()) : "None");
    if (c.methods?.length) row("Methods", monoList(c.methods));
    if (c.swaps?.length) row("Swaps", c.swaps.map((p) => (Array.isArray(p) ? p.join(" to ") : String(p))).join(", "));
    if (c.activeHoursUtc) row("Hours", `${c.activeHoursUtc.join?.(" to ") ?? JSON.stringify(c.activeHoursUtc)} UTC`);
    row("Purposes", c.purposes?.length ? list(c.purposes).replace(/^./, (x) => x.toUpperCase()) : "Any purpose");
  }

  // ---------- export ----------
  function renderExport(j, text) {
    $("#x-policy").textContent = JSON.stringify(j.outlayerPolicy, null, 2);
    $("#x-guard").textContent = JSON.stringify(j.guardConfig, null, 2);
    const esc = text.replace(/\s+/g, " ").trim().replace(/(["\\$`])/g, "\\$1");
    $("#x-proxy").textContent = `MANDATE="${esc}" \\\n  npm run proxy`;
    const ctx = { userInstruction: "Pay the hosting invoice from cloudhost.testnet.", retrieved: ["Invoice #4471. Amount due: 3 NEAR. Pay to: cloudhost.testnet."], reasoning: "The user asked me to pay this invoice.", provenance: "user" };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(ctx))));
    $("#x-header").textContent = `x-siege-context: ${b64}\n\n# decoded\n${JSON.stringify(ctx, null, 2)}`;
  }
  $$("[data-copy]").forEach((b) =>
    b.addEventListener("click", async () => {
      const t = $("#" + b.dataset.copy).textContent;
      try {
        await navigator.clipboard.writeText(t);
        b.textContent = "Copied";
      } catch {
        b.textContent = "Select and copy";
      }
      setTimeout(() => (b.textContent = "Copy"), 1600);
    }),
  );

  // ---------- examples ----------
  let examples = null;
  $$("[data-example]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        examples ??= await (await fetch("/api/examples")).json();
      } catch {
        return showCompileError("Can't reach the SIEGE server to load the examples.");
      }
      setMode("edit");
      ta.value = examples[b.dataset.example] ?? ta.value;
      $$("[data-example]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      resetSiege();
      compile();
    }),
  );

  // ---------- document modes ----------
  function setMode(mode) {
    const annotated = mode === "annotated";
    ta.hidden = annotated;
    clausesEl.hidden = !annotated;
    generalEl.hidden = !annotated || !generalEl.childElementCount;
    editBtn.hidden = !annotated;
  }
  editBtn.addEventListener("click", () => {
    setMode("edit");
    ta.focus();
  });

  // ---------- siege ----------
  const guards = {};
  for (const g of ["outlayer", "mandate"]) {
    const root = $(`#g-${g}`);
    guards[g] = { root, num: $(".guard__num", root), phase: $(".guard__phase", root), path: $(".spark__line", root), hist: [] };
  }
  let maxLoss = 1;

  function resetSiege() {
    if (es) es.close(), (es = null);
    queue.length = 0;
    clearTimeout(drainTimer);
    drainTimer = null;
    siegeEl.dataset.state = "idle";
    stateEl.textContent = "Not started";
    for (const g of Object.values(guards)) {
      g.hist = [];
      g.root.dataset.phase = "waiting";
      delete g.root.dataset.outcome;
      g.phase.textContent = "Waiting";
      g.num.textContent = near(0);
      g.path.setAttribute("d", "");
    }
    maxLoss = 1;
    $("#honest").hidden = true;
    $("#ledgers").hidden = true;
    $("#siege-error").hidden = true;
    siegeBtn.removeAttribute("aria-busy");
  }

  function drawSpark(g) {
    const h = g.hist;
    if (!h.length) return g.path.setAttribute("d", "");
    const n = Math.max(GENERATIONS, h.length);
    const y = (v) => 38 - (v / maxLoss) * 36;
    let d = `M0 ${y(h[0]).toFixed(2)}`;
    h.forEach((v, i) => {
      const x0 = (i / n) * 100, x1 = ((i + 1) / n) * 100;
      d += ` L${x0.toFixed(2)} ${y(v).toFixed(2)} L${x1.toFixed(2)} ${y(v).toFixed(2)}`;
    });
    g.path.setAttribute("d", d);
  }

  function onProgress(p) {
    const g = guards[p.guard];
    if (!g) return;
    for (const [k, o] of Object.entries(guards)) if (k !== p.guard && o.root.dataset.phase === "running") finishGuard(k);
    g.root.dataset.phase = "running";
    g.hist[p.generation] = p.bestLoss;
    maxLoss = Math.max(maxLoss, p.bestLoss);
    g.num.textContent = near(p.bestLoss);
    g.phase.textContent = `Generation ${p.generation + 1} of ${p.generations}`;
    stateEl.textContent = `Attacking ${SHORT[p.guard].toLowerCase()}, ${p.evaluations.toLocaleString("en")} attacks tried`;
    Object.values(guards).forEach(drawSpark);
  }
  function finishGuard(k, loss) {
    const g = guards[k];
    const v = loss ?? g.hist.at(-1) ?? 0;
    g.root.dataset.phase = "done";
    g.root.dataset.outcome = v > 0 ? "breach" : "held";
    g.num.textContent = near(v);
    g.phase.textContent = v > 0 ? "Drained" : "Held";
  }

  function onAttack(a) {
    finishGuard(a.guard, a.loss);
    if (a.history?.length) (guards[a.guard].hist = a.history), Object.values(guards).forEach(drawSpark);
    const ol = $(`#l-${a.guard}`);
    ol.replaceChildren();
    const rows = a.steps.map((s) => {
      const dest = s.routedTo || s.to;
      const lost = s.verdict === "allow" && !legit.has(dest) && !(s.kind === "call" && !s.routedTo);
      const cls = s.verdict !== "allow" ? "stopped" : lost ? "lost" : "paid";
      const word = cls === "stopped" ? "Stopped" : cls === "lost" ? "Lost" : "Paid";
      const to = el("span", { class: "step__to" }, account(s.to));
      if (s.kind === "call") to.append(el("span", { class: "via", text: ` calls ${s.method}, routed to ` }), s.routedTo ? account(s.routedTo) : el("span", { class: "via", text: "itself" }));
      const ctx = el("p", { class: "step__ctx" }, `Asked: \u201c${s.user}\u201d`);
      if (s.doc) ctx.append(` Read: \u201c${s.doc.split("\n").join(" ").slice(0, 110)}${s.doc.length > 110 ? "…" : ""}\u201d`);
      if (cls === "stopped" && s.reasons?.length) ctx.append(el("br"), `Stopped for: ${s.reasons.map(human).join("; ").toLowerCase()}`);
      return el("li", { class: `step step--${cls}` }, to, el("span", { class: "step__amt", text: `${near(s.amount)} NEAR` }), el("span", { class: "step__v", text: word }), ctx);
    });
    const LIMIT = 5;
    rows.forEach((r, i) => (i >= LIMIT && (r.hidden = true), ol.append(r)));
    const old = ol.nextElementSibling;
    if (old?.classList.contains("ledger__more")) old.remove();
    if (rows.length > LIMIT) {
      const more = el("button", { type: "button", class: "btn btn--quiet btn--s ledger__more", "aria-expanded": "false", text: `Show all ${rows.length} steps` });
      more.addEventListener("click", () => {
        const open = more.getAttribute("aria-expanded") === "true";
        rows.forEach((r, i) => i >= LIMIT && (r.hidden = open));
        more.setAttribute("aria-expanded", String(!open));
        more.textContent = open ? `Show all ${rows.length} steps` : "Show fewer";
      });
      ol.after(more);
    }
    if (!rows.length) ol.append(el("li", { class: "step step--stopped" }, el("span", { class: "step__ctx", text: "The search kept no attack steps for this guard." })));
  }

  function noteFor(findings) {
    const note = el("div", { class: "note" });
    for (const g of ["outlayer", "mandate"]) {
      const fs = findings.filter((f) => f.guard === g).sort((a, b) => b.loss - a.loss);
      if (!fs.length) {
        if (findings.length) note.append(el("div", { class: "note__guard note__guard--held" }, el("span", { class: "note__who" }, `${SHORT[g]}: `, el("span", { class: "note__loss", text: "held" }))));
        continue;
      }
      const sum = fs.reduce((a, f) => a + f.loss, 0);
      const fixes = [...new Set(fs.map((f) => f.fix).filter(Boolean))];
      note.append(
        el(
          "div",
          { class: "note__guard note__guard--breach" },
          el("span", { class: "note__who" }, `${SHORT[g]}: `, el("span", { class: "note__loss", text: `lost ${near(sum)} NEAR` })),
          el("span", { class: "note__how", text: fs[0].how }),
          ...fixes.map((f) => el("span", { class: "note__fix" }, el("b", { text: "Fix: " }), f)),
        ),
      );
    }
    return note;
  }

  function onDone(d) {
    for (const [k, v] of Object.entries(d.losses || {})) finishGuard(k, v);
    clausesEl.replaceChildren();
    for (const s of d.sentences) {
      const breach = s.findings.length > 0;
      clausesEl.append(
        el(
          "li",
          { class: `clause clause--${breach ? "breach" : "held"}` },
          el("span", { class: "clause__text", text: s.text }),
          breach ? noteFor(s.findings) : el("div", { class: "note" }, el("span", { class: "note--held", text: "Held against both guards." })),
        ),
      );
    }
    generalEl.replaceChildren();
    if (d.general?.length) {
      generalEl.append(el("h3", { text: "Not tied to one sentence" }), noteFor(d.general));
    }
    setMode("annotated");
        const honest = $("#honest");
    honest.replaceChildren(`No worse attack found in `, el("b", { text: d.evaluations.toLocaleString("en") }), ` evaluations. This is a bounded search, not a proof.`);
    honest.hidden = false;
    $("#ledgers").hidden = false;
    siegeEl.dataset.state = "done";
    stateEl.textContent = `Finished, ${d.evaluations.toLocaleString("en")} evaluations`;
    siegeBtn.removeAttribute("aria-busy");
    siegeBtn.firstChild.textContent = "Lay siege again ";
  }

  // The engine is fast; pace the stream so each generation is seen. Reduced motion shows it at once.
  const queue = [];
  let drainTimer = null;
  function push(type, data) {
    queue.push([type, data]);
    if (!drainTimer) drain();
  }
  function drain() {
    const item = queue.shift();
    if (!item) return void (drainTimer = null);
    const [type, data] = item;
    if (type === "progress") onProgress(data);
    else if (type === "attack") onAttack(data);
    else if (type === "done") onDone(data);
    drainTimer = setTimeout(drain, reduced || type !== "progress" ? 0 : 45);
  }

  function siegeError(msg) {
    if (es) es.close(), (es = null);
    siegeEl.dataset.state = "error";
    stateEl.textContent = "Stopped";
    $("#siege-error-msg").textContent = msg;
    $("#siege-error").hidden = false;
    siegeBtn.removeAttribute("aria-busy");
    for (const g of Object.values(guards)) if (g.root.dataset.phase === "running") (g.root.dataset.phase = "waiting"), (g.phase.textContent = "Interrupted");
  }

  async function laySiege() {
    if (siegeBtn.getAttribute("aria-busy") === "true") return;
    if (!compileOk) {
      ta.focus();
      return void (status.textContent ||= "Fix the mandate first.");
    }
    resetSiege();
    setMode("edit");
    siegeEl.dataset.state = "running";
    stateEl.textContent = "Starting the attacker…";
    siegeBtn.setAttribute("aria-busy", "true");
    const text = ta.value;
    let started = false, finished = false;
    es = new EventSource(`/api/siege?mandate=${encodeURIComponent(text)}&generations=${GENERATIONS}`);
    es.addEventListener("start", (e) => {
      started = true;
      const s = JSON.parse(e.data);
      legit = new Set(s.legit || []);
      guards.outlayer.root.dataset.phase = "running";
      guards.outlayer.phase.textContent = `Generation 0 of ${s.generations}`;
    });
    es.addEventListener("progress", (e) => push("progress", JSON.parse(e.data)));
    es.addEventListener("attack", (e) => push("attack", JSON.parse(e.data)));
    es.addEventListener("done", (e) => {
      finished = true;
      es.close();
      es = null;
      push("done", JSON.parse(e.data));
    });
    es.addEventListener("error", async () => {
      if (finished) return;
      if (es) es.close(), (es = null);
      if (started) return siegeError("The siege stopped before it finished. The connection to the server dropped.");
      try {
        const h = await (await fetch("/healthz", { cache: "no-store" })).json();
        siegeError(h.sieges > 0 ? "The attacker is busy with other sieges. Try again in a few seconds." : "The server refused this siege. Check the mandate compiles, then try again.");
      } catch {
        siegeError("Can't reach the SIEGE server. Check it is running, then try again.");
      }
    });
  }
  siegeBtn.addEventListener("click", laySiege);
  $("#retry-btn").addEventListener("click", laySiege);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      laySiege();
    }
  });
  if (/Mac|iPhone|iPad/.test(navigator.platform)) $("#siege-btn kbd").textContent = "\u2318 Enter";

  // ---------- try a transaction ----------
  const form = $("#try-form");
  const syncKind = () => $$(".call-only").forEach((n) => (n.hidden = !$("#k-call").checked));
  $$('input[name="kind"]').forEach((r) => r.addEventListener("change", syncKind));
  syncKind();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#try-msg");
    msg.textContent = "";
    const fd = Object.fromEntries(new FormData(form));
    $$(".input", form).forEach((i) => i.removeAttribute("aria-invalid"));
    const btn = $("#try-btn");
    btn.setAttribute("aria-busy", "true");
    try {
      const r = await fetch("/api/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mandate: ta.value, tx: { ...fd, amount: Number(fd.amount) } }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        msg.textContent = r.status === 422 ? `The mandate does not compile: ${j.error}.` : `${(j.error || "That did not go through").replace(/^./, (x) => x.toUpperCase())}.`;
        const bad = /amount/.test(j.error) ? "#t-amount" : /recipient/.test(j.error) ? "#t-to" : /arguments/.test(j.error) ? "#t-args" : null;
        if (bad) $(bad).setAttribute("aria-invalid", "true"), $(bad).focus();
        return;
      }
      renderVerdicts(j);
    } catch {
      msg.textContent = "Can't reach the SIEGE server. Check it is running, then try again.";
    } finally {
      btn.removeAttribute("aria-busy");
    }
  });
  function renderVerdicts(j) {
    const box = $("#verdicts");
    box.replaceChildren();
    for (const g of ["outlayer", "mandate"]) {
      const v = j[g];
      const allow = v.verdict === "allow";
      const why = v.reasons?.length ? v.reasons.map(human).join("; ") : allow ? "Nothing in its policy stops this." : "";
      box.append(
        el(
          "div",
          { class: `verdict verdict--${allow ? "allow" : "deny"}` },
          el("span", { class: "verdict__who", text: GUARD[g] }),
          el("span", { class: "verdict__says", text: allow ? "Would send it" : v.verdict === "deny" ? "Would refuse it" : `Would ${v.verdict} it` }),
          el("span", { class: "verdict__why", text: why }),
        ),
      );
    }
    const sig = el("div", { class: "signals" }, el("h4", { text: `What the classifier saw, risk ${Number(j.risk).toFixed(2)}` }));
    const ul = el("ul");
    if (!j.signals?.length) ul.append(el("li", {}, el("span", { class: "w", text: "0" }), el("span", { text: "No signals" }), el("span", { class: "d", text: "Nothing about this transaction looked off." })));
    for (const s of j.signals || []) ul.append(el("li", {}, el("span", { class: "w", text: Number(s.weight).toFixed(2) }), el("span", { text: human(s.code) }), el("span", { class: "d", text: s.detail })));
    sig.append(ul);
    box.append(sig);
    box.hidden = false;
  }

  // ---------- start ----------
  compile().then(() => {
    if (new URLSearchParams(location.search).get("autosiege") === "1" && compileOk) laySiege();
  });
})();
