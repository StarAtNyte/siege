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
  const MAX = Number($("#mandate").getAttribute("maxlength")) || 2000;

  const ta = $("#mandate");
  const status = $("#doc-status");
  const siegeBtn = $("#siege-btn");
  const editBtn = $("#edit-btn");
  const clausesEl = $("#clauses");
  const generalEl = $("#general");
  const siegeEl = $("#siege");
  const stateEl = $("#siege-state");
  const liveEl = $("#siege-live");
  const btnLabel = $(".btn__label", siegeBtn);

  let compiled = null; // last good compile response
  let compileOk = false;
  let compileSeq = 0;
  let es = null;
  let legit = new Set();
  let lastBudget = null; // the Mandate guard's new-payee budget, from the finished siege
  let hasResult = false; // a finished siege is on screen; it stays until a new run actually connects
  let lastRun = null; // { text, losses } of the last finished siege
  let prevRun = null; // the finished run a new siege is compared against

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
  // A server message as one plain sentence: capital first, exactly one full stop.
  const sentence = (s) => String(s).trim().replace(/[.\s]+$/, "").replace(/^./, (x) => x.toUpperCase()) + ".";
  const why422 = (err) => `SIEGE can’t test this mandate yet: ${String(err).trim().replace(/[.\s]+$/, "")}.`;
  // Screen-reader announcements for the siege, throttled so a fast run is not read out generation by generation.
  let lastSaid = 0;
  function announce(msg, force = false) {
    const now = Date.now();
    if (!force && now - lastSaid < 4000) return;
    lastSaid = now;
    liveEl.textContent = msg;
  }
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
      if (!r.ok) return showCompileError(r.status === 422 ? why422(j.error) : j.error ? sentence(j.error) : `The server answered ${r.status}. Edit the mandate to retry.`);
      compiled = j;
      compileOk = true;
      ta.removeAttribute("aria-invalid");
      status.textContent = "";
      siegeBtn.removeAttribute("aria-disabled");
      renderReading(j.constraints);
      renderExport(j, text);
    } catch {
      if (seq !== compileSeq) return;
      showCompileError("Can’t reach the SIEGE server. It retries when you edit the mandate or come back to this tab.");
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
    $("#reading").replaceChildren(el("div", { class: "reading__row reading__row--empty" }, el("dd", { text: "Nothing to read yet. Fix the mandate above." })));
    staleExport();
  }
  // Characters left, shown only near the limit; a paste that would overflow says it was cut.
  function count(cut = false) {
    const n = ta.value.length;
    const c = $("#doc-count");
    c.hidden = n < MAX * 0.8 && !cut;
    c.dataset.tone = n >= MAX ? "full" : "";
    c.textContent = cut ? `The pasted text was cut at ${MAX.toLocaleString("en")} characters. Shorten a sentence to fit the rest.` : n >= MAX ? `At the ${MAX.toLocaleString("en")} character limit.` : `${n.toLocaleString("en")} of ${MAX.toLocaleString("en")} characters`;
  }
  ta.addEventListener("paste", (e) => {
    const add = e.clipboardData?.getData("text")?.length ?? 0;
    const sel = ta.selectionEnd - ta.selectionStart;
    if (ta.value.length - sel + add > MAX) setTimeout(() => count(true));
  });
  // Grow the mandate to fit its text (where field-sizing: content is missing, as on Safari and Firefox).
  const sizesItself = CSS.supports("field-sizing", "content");
  function fit() {
    if (sizesItself || ta.hidden) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }
  let debounce;
  ta.addEventListener("input", () => {
    fit();
    count();
    // The siege tests the text it started with: an edit stops a running siege and marks a finished one as out of date.
    if (siegeEl.dataset.state === "running") siegeError("Stopped: the mandate changed. Lay siege again to test the new text.", "Lay siege on the new text");
    else if (siegeEl.dataset.state === "done" && !siegeEl.dataset.stale) {
      siegeEl.dataset.stale = "true";
      stateEl.textContent = "Out of date: the mandate changed. Lay siege again.";
      announce("The siege results are out of date: the mandate changed.", true);
    }
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
  function staleExport() {
    $("#x-policy").textContent = "Fix the mandate above to see its OutLayer policy.";
    for (const id of ["x-guard", "x-proxy", "x-header"]) $("#" + id).textContent = "";
    $$("[data-copy], [data-download]").forEach((b) => b.setAttribute("aria-disabled", "true"));
  }
  function renderExport(j, text) {
    $$("[data-copy], [data-download]").forEach((b) => b.removeAttribute("aria-disabled"));
    $("#x-policy").textContent = JSON.stringify(j.outlayerPolicy, null, 2);
    $("#x-guard").textContent = JSON.stringify(j.guardConfig, null, 2);
    // Single quotes keep the shell from touching $, `, ! or \ in the mandate; a ' inside becomes '\''.
    const esc = text.replace(/\s+/g, " ").trim().replace(/'/g, "'\\''");
    $("#x-proxy").textContent = `MANDATE='${esc}' \\\n  npm run proxy`;
    const ctx = { userInstruction: "Pay the hosting invoice from cloudhost.testnet.", retrieved: ["Invoice #4471. Amount due: 3 NEAR. Pay to: cloudhost.testnet."], reasoning: "The user asked me to pay this invoice.", provenance: "user" };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(ctx))));
    $("#x-header").textContent = `x-siege-context: ${b64}\n\n# decoded\n${JSON.stringify(ctx, null, 2)}`;
  }
  $$("[data-copy]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (b.getAttribute("aria-disabled") === "true") return;
      const pre = $("#" + b.dataset.copy);
      try {
        await navigator.clipboard.writeText(pre.textContent);
        b.textContent = "Copied";
      } catch {
        // No clipboard access (an insecure origin, or permission refused): select the text so the keyboard copy works.
        const range = document.createRange();
        range.selectNodeContents(pre);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        pre.focus();
        b.textContent = "Selected, now copy";
      }
      setTimeout(() => (b.textContent = "Copy"), 2400);
    }),
  );
  $$("[data-download]").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.getAttribute("aria-disabled") === "true") return;
      const blob = new Blob([$("#" + b.dataset.download).textContent + "\n"], { type: "application/json" });
      const a = el("a", { href: URL.createObjectURL(blob), download: b.dataset.file });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }),
  );

  // ---------- examples ----------
  let examples = null;
  const pick = $("#example-select");
  async function loadExample(name) {
    try {
      examples ??= await (await fetch("/api/examples")).json();
    } catch {
      return showCompileError("Can’t reach the SIEGE server to load the examples. Try again in a moment.");
    }
    setMode("edit");
    ta.value = examples[name] ?? ta.value;
    fit();
    $$("[data-example]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.example === name)));
    pick.value = name;
    resetSiege();
    compile();
  }
  $$("[data-example]").forEach((b) => b.addEventListener("click", () => loadExample(b.dataset.example)));
  pick.addEventListener("change", () => pick.value && loadExample(pick.value));

  // ---------- document modes ----------
  function setMode(mode) {
    const annotated = mode === "annotated";
    ta.hidden = annotated;
    clausesEl.hidden = !annotated;
    generalEl.hidden = !annotated || !generalEl.childElementCount;
    editBtn.hidden = !annotated;
    fit();
  }
  editBtn.addEventListener("click", () => {
    setMode("edit");
    ta.focus();
  });

  // ---------- siege ----------
  const guards = {};
  for (const g of ["outlayer", "mandate"]) {
    const root = $(`#g-${g}`);
    guards[g] = { root, num: $(".guard__num", root), phase: $(".guard__phase", root), compare: $(".guard__compare", root), clauses: $(".guard__clauses", root), path: $(".spark__line", root), svg: $(".spark__svg", root), dots: $(".spark__dots", root), budget: $(".budget", root), hist: [], loss: 0 };
  }

  function resetSiege(keepStream = false) {
    if (es && !keepStream) es.close(), (es = null);
    queue.length = 0;
    clearTimeout(drainTimer);
    drainTimer = null;
    siegeEl.dataset.state = "idle";
    delete siegeEl.dataset.stale;
    delete siegeEl.dataset.prev;
    clausesEl.removeAttribute("data-prev");
    $("#siege-prev").hidden = true;
    hasResult = false;
    stateEl.textContent = "Not started";
    btnLabel.textContent = "Lay siege";
    for (const g of Object.values(guards)) {
      g.hist = [];
      g.loss = 0;
      g.compare.hidden = true;
      g.clauses.hidden = true;
      g.root.dataset.phase = "waiting";
      delete g.root.dataset.outcome;
      g.phase.textContent = "Waiting";
      g.num.textContent = near(0);
      g.path.setAttribute("d", "");
      g.dots.replaceChildren();
      $(".spark__val", g.root).hidden = true;
      g.budget.hidden = true;
    }
    lastBudget = null;
    $("#siege-verdict").hidden = true;
    $("#honest").hidden = true;
    $("#ledgers").hidden = true;
    $("#next").hidden = true;
    $("#siege-error").hidden = true;
    siegeBtn.removeAttribute("aria-busy");
  }

  // One y-max for both guards, so 1.02 against 177.20 shows the real gap; a loss above 0 still rises at least 2px, gets its break dots and a value label.
  function sparkPeak() {
    return Math.max(0, ...Object.values(guards).flatMap((o) => o.hist.filter((v) => v != null)));
  }
  function drawSpark(g) {
    const h = g.hist;
    const label = $(".spark__val", g.root);
    if (!h.length) return g.path.setAttribute("d", ""), label && (label.hidden = true);
    const n = Math.max(GENERATIONS, h.length);
    const peak = sparkPeak();
    const plotH = g.svg.getBoundingClientRect().height || 48;
    const minRise = (2 * 40) / plotH;
    const y = (v) => (peak > 0 && (v ?? 0) > 0 ? 38 - Math.max(((v ?? 0) / peak) * 36, minRise) : 38);
    let d = `M0 ${y(h[0]).toFixed(2)}`;
    h.forEach((v, i) => {
      const x0 = (i / n) * 100, x1 = ((i + 1) / n) * 100;
      d += ` L${x0.toFixed(2)} ${y(v).toFixed(2)} L${x1.toFixed(2)} ${y(v).toFixed(2)}`;
    });
    g.path.setAttribute("d", d);
    // A dot at each generation where the best attack got bigger, so a late jump reads as a find, not a glitch.
    const breaks = [];
    h.forEach((v, i) => v > 0 && v > (i ? h[i - 1] ?? 0 : 0) && breaks.push(i));
    const have = g.dots.childElementCount;
    if (have > breaks.length) g.dots.replaceChildren();
    breaks.forEach((i, k) => {
      const left = `${(((i + 0.5) / n) * 100).toFixed(2)}%`, top = `${((y(h[i]) / 40) * 100).toFixed(2)}%`;
      const dot = g.dots.children[k] ?? g.dots.appendChild(el("span", { class: "spark__dot" }));
      dot.style.left = left;
      dot.style.top = top;
      dot.title = `Round ${i + 1}: ${near(h[i])} NEAR`;
    });
    const last = h.at(-1) ?? 0;
    const endY = (y(last) / 40) * 100;
    label.hidden = false;
    label.textContent = near(last);
    label.style.left = `${Math.max(0, Math.min(100, (h.length / n) * 100)).toFixed(2)}%`;
    label.style.top = `${endY.toFixed(2)}%`;
    const name = g.svg.getAttribute("aria-label").split(", ").slice(-1)[0];
    g.svg.setAttribute("aria-label", `Chart: best loss found by attack round, ${name}. ${breaks.length ? `Bigger breaks found in round ${list(breaks.map((i) => String(i + 1)))}.` : "No break found."}`);
  }

  function onProgress(p) {
    const g = guards[p.guard];
    if (!g) return;
    for (const [k, o] of Object.entries(guards)) if (k !== p.guard && o.root.dataset.phase === "running") finishGuard(k);
    g.root.dataset.phase = "running";
    g.hist[p.generation] = p.bestLoss;
    g.num.textContent = near(p.bestLoss);
    g.phase.textContent = `Attack round ${p.generation + 1} of ${p.generations}`;
    stateEl.textContent = `Attacking ${SHORT[p.guard].toLowerCase()}, ${p.evaluations.toLocaleString("en")} attacks tried`;
    announce(`${GUARD[p.guard]}: attack round ${p.generation + 1} of ${p.generations}, ${near(p.bestLoss)} NEAR lost so far.`);
    Object.values(guards).forEach(drawSpark);
    redline(p);
  }

  // ---------- live red-lining ----------
  // While the siege runs, the mandate is shown as clauses and each one is marked the moment the attacker first gets through it.
  function liveClauses() {
    clausesEl.replaceChildren();
    generalEl.replaceChildren();
    for (const s of compiled?.sentences ?? []) {
      clausesEl.append(el("li", { class: "clause clause--pending", "data-index": s.index }, el("span", { class: "clause__text", text: s.text }), el("div", { class: "note note--live" })));
    }
    return clausesEl.childElementCount > 0;
  }
  function redline(p) {
    for (const m of p.marks ?? []) {
      const li = clausesEl.querySelector(`[data-index="${m.index}"]`);
      if (!li) continue;
      const note = $(".note--live", li);
      let mark = note && $(`[data-guard="${p.guard}"]`, note);
      if (!note) continue;
      if (!mark) {
        mark = el("span", { class: "live-mark live-mark--fresh", "data-guard": p.guard }, `${SHORT[p.guard]} broken in round ${p.generation + 1}, `, el("span", { class: "note__loss" }));
        note.append(mark);
        if (!li.classList.contains("clause--breach")) li.classList.replace("clause--pending", "clause--breach"), li.classList.add("clause--fresh");
      }
      $(".note__loss", mark).textContent = `lost ${near(m.loss)} NEAR`;
    }
  }
  function finishGuard(k, loss) {
    const g = guards[k];
    g.loss = loss ?? g.hist.at(-1) ?? 0;
    g.root.dataset.phase = "done";
    g.num.textContent = near(g.loss);
    Object.keys(guards).forEach(grade);
    if (siegeEl.dataset.state === "running") announce(`${GUARD[k]} finished: ${near(g.loss)} NEAR lost.`, true);
  }
  // Held: nothing lost. Held to budget: everything lost went through the mandate's new-payee budget and stayed inside it.
  // Mostly held: lost, but at least 90% less than the other guard. Drained: otherwise.
  function grade(k) {
    const g = guards[k];
    if (g.root.dataset.phase !== "done") return;
    if (k === "mandate" && g.loss > 0 && lastBudget?.withinBudget) {
      const b = lastBudget;
      g.root.dataset.outcome = "budget";
      g.phase.textContent = "Held to its allowance";
      g.compare.textContent = `All of it went to new payees, inside the ${near(b.cap)} NEAR ${hours(b.hours)} the mandate allows them.`;
      g.compare.hidden = false;
      $(".budget__fill", g.budget).style.setProperty("--used", String(Math.min(1, g.loss / b.cap)));
      $(".budget__text", g.budget).textContent = `${near(g.loss)} of ${near(b.cap)} NEAR new-payee allowance used`;
      g.budget.hidden = false;
      return;
    }
    g.budget.hidden = true;
    const [ok, other] = Object.entries(guards).find(([x]) => x !== k);
    const theirs = other.root.dataset.phase === "done" ? other.loss : null;
    const v = g.loss;
    const cut = theirs > 0 ? 1 - v / theirs : 0;
    const tier = v <= 0 ? "held" : cut >= 0.9 ? "partial" : "breach";
    g.root.dataset.outcome = tier;
    g.phase.textContent = tier === "held" ? "Held" : tier === "partial" ? "Mostly held" : "Drained";
    g.compare.textContent = tier === "partial" ? `${Math.floor(cut * 100)}% less lost than ${SHORT[ok].toLowerCase()}` : "";
    g.compare.hidden = tier !== "partial";
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
      // Against the plain policy losing is the default, so only the rows that went otherwise carry a chip.
      const chip = a.guard === "outlayer" && cls === "lost" ? el("span", { class: "step__v step__v--none" }, el("span", { class: "visually-hidden", text: word })) : el("span", { class: "step__v", text: word });
      const to = el("span", { class: "step__to" }, account(s.to));
      if (s.kind === "call") to.append(el("span", { class: "via", text: ` calls ${s.method}, routed to ` }), s.routedTo ? account(s.routedTo) : el("span", { class: "via", text: "itself" }));
      const ctx = el("p", { class: "step__ctx" }, `Asked: \u201c${s.user}\u201d`);
      if (s.doc) ctx.append(` Read: \u201c${s.doc.split("\n").join(" ").slice(0, 110)}${s.doc.length > 110 ? "…" : ""}\u201d`);
      if (cls === "stopped" && s.reasons?.length) ctx.append(el("br"), `Stopped for: ${s.reasons.map(human).join("; ").toLowerCase()}`);
      return el("li", { class: `step step--${cls}` }, to, el("span", { class: "step__amt", text: `${near(s.amount)} NEAR` }), chip, ctx);
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

  // The short line is the fix's last sentence: in the diagnoser's strings that is the instruction, the earlier ones are the reason.
  const shortFix = (f) => f.split(/(?<=[.!?])\s+(?=[A-Z"])/).filter(Boolean).at(-1) ?? f;
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
      const inBudget = g === "mandate" && lastBudget?.withinBudget && fs.every((f) => f.kind === "theft");
      note.append(
        el(
          "div",
          { class: `note__guard note__guard--${inBudget ? "budget" : "breach"}` },
          el("span", { class: "note__who" }, `${SHORT[g]}: `, el("span", { class: "note__loss", text: `lost ${near(sum)} NEAR` })),
          inBudget && el("span", { class: "note__why", text: `Inside the guard’s ${near(lastBudget.cap)} NEAR ${hours(lastBudget.hours)} allowance for new payees.` }),
          fixes.length && el("span", { class: "note__fix" }, el("b", { text: "Fix: " }), shortFix(fixes[0])),
          (fixes.length || fs[0].how) &&
            el(
              "details",
              { class: "note__story" },
              el("summary", { text: "Details" }),
              ...fixes.map((f) => el("p", { class: "note__fix note__fix--full" }, el("b", { text: "Fix: " }), f)),
              fs[0].how && el("p", { class: "note__how" }, el("b", { text: "How it was attacked: " }), fs[0].how),
            ),
        ),
      );
    }
    return note;
  }

  function verdictLine(d) {
    const o = d.losses?.outlayer ?? 0, m = d.losses?.mandate ?? 0, b = d.budget;
    const first = o > 0 ? `Without SIEGE, the attacker took ${near(o)} NEAR.` : "Without SIEGE, the attacker took nothing.";
    const second =
      m <= 0 ? "With the Mandate guard: 0.00 NEAR." : b?.withinBudget ? `With the Mandate guard: ${near(m)}, within its new-payee allowance.` : `With the Mandate guard: ${near(m)} NEAR.`;
    const v = $("#siege-verdict");
    v.replaceChildren(el("span", { class: "siege__verdict-a", text: first }), " ", el("span", { class: "siege__verdict-b", text: second }));
    v.hidden = false;
    return `${first} ${second}`;
  }

  function onDone(d) {
    lastBudget = d.budget ?? null;
    for (const [k, v] of Object.entries(d.losses || {})) finishGuard(k, v);
    const said = verdictLine(d);
    // Each card says how many of the mandate's clauses its guard let through, counted from the same findings the clauses show.
    const total = d.sentences.length;
    for (const [k, g] of Object.entries(guards)) {
      const n = d.sentences.filter((s) => s.findings.some((f) => f.guard === k)).length;
      const word = total === 1 ? "clause" : "clauses";
      g.clauses.textContent = n > 0 ? `Breached ${n} of ${total} ${word}` : `Held all ${total} ${word}`;
      g.clauses.hidden = total === 0;
    }
    clausesEl.replaceChildren();
    for (const s of d.sentences) {
      const breach = s.findings.length > 0;
      clausesEl.append(
        el(
          "li",
          { class: `clause clause--${breach ? "breach" : "held"}`, "data-index": s.index },
          el("span", { class: "clause__text", text: s.text }),
          breach ? noteFor(s.findings) : el("div", { class: "note" }, el("span", { class: "note--held", text: "Held against both guards." })),
        ),
      );
    }
    generalEl.replaceChildren();
    if (d.general?.length) {
      generalEl.append(el("h2", { text: "Not tied to one sentence" }), noteFor(d.general));
    }
    setMode("annotated");
    const honest = $("#honest");
    honest.replaceChildren(`No worse attack found in `, el("b", { text: d.evaluations.toLocaleString("en") }), ` attacks tried. This is a bounded search, not a proof.`);
    honest.hidden = false;
    $("#ledgers").hidden = false;
    siegeEl.dataset.state = "done";
    hasResult = true;
    stateEl.textContent = `Finished, ${d.evaluations.toLocaleString("en")} attacks tried`;
    renderNext(d);
    // The mandate's notes grow during the run and push the siege down on phones: land on the verdict when it is in.
    if (matchMedia("(max-width: 40rem)").matches) siegeEl.scrollIntoView({ behavior: "auto", block: "start" });
    siegeBtn.removeAttribute("aria-busy");
    btnLabel.textContent = "Lay siege again";
    announce(`Siege finished. ${said} Breached clauses are marked in the mandate.`, true);
    // A keyboard user who started the siege lands on the verdict, then tabs on to the clause details and ledgers.
    if (focusAfter()) $("#siege-verdict").focus({ preventScroll: true });
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

  // Focus moves with the siege only when it would otherwise be lost: on the page, the hidden mandate, or the siege heading.
  const focusAfter = () => [document.body, ta, $("#siege-h"), null].includes(document.activeElement);
  function siegeError(msg, retry = "Try again") {
    if (es) es.close(), (es = null);
    // Drop the events still queued for display, so the stopped run does not keep animating.
    queue.length = 0;
    clearTimeout(drainTimer);
    drainTimer = null;
    siegeEl.dataset.state = "error";
    stateEl.textContent = "Stopped";
    $("#siege-error-msg").textContent = msg;
    $("#retry-btn").textContent = retry;
    $("#siege-error").hidden = false;
    siegeBtn.removeAttribute("aria-busy");
    btnLabel.textContent = "Lay siege";
    const typing = document.activeElement === ta && !ta.hidden;
    if (hasResult) {
      // The new run never connected: the last finished result stays, dimmed and labelled, beside the error.
      siegeEl.dataset.prev = "true";
      clausesEl.dataset.prev = "true";
      $("#siege-prev").hidden = false;
      if (typing) setMode("edit");
    } else {
      for (const g of Object.values(guards)) if (g.root.dataset.phase !== "done") (g.phase.textContent = g.root.dataset.phase === "running" ? "Interrupted" : "Not run"), (g.root.dataset.phase = "waiting");
      setMode("edit");
    }
    announce(msg, true);
    if (!typing && focusAfter()) $("#retry-btn").focus({ preventScroll: true });
  }

  async function laySiege() {
    if (siegeBtn.getAttribute("aria-busy") === "true") return;
    if (!compileOk) {
      ta.focus();
      return void (status.textContent ||= "Fix the mandate first.");
    }
    const moveFocus = focusAfter();
    const running = (label) => {
      siegeEl.dataset.state = "running";
      stateEl.textContent = label;
      siegeBtn.setAttribute("aria-busy", "true");
      btnLabel.textContent = "Laying siege…";
    };
    // Clear the board and show the live clauses. With a finished result on screen this waits for the first event, so a dead server does not wipe it.
    const clearBoard = (keepStream) => {
      resetSiege(keepStream);
      setMode(liveClauses() ? "annotated" : "edit");
    };
    if (hasResult) {
      if (es) es.close(), (es = null);
      queue.length = 0;
      clearTimeout(drainTimer);
      drainTimer = null;
      $("#siege-error").hidden = true;
    } else clearBoard();
    if (moveFocus) $("#siege-h").focus({ preventScroll: true });
    announce("Siege started. Attacking plain OutLayer policy first, then the Mandate guard.", true);
    // On phones the siege sits below the mandate, out of sight: bring it up as it starts.
    if (matchMedia("(max-width: 40rem)").matches) siegeEl.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    running("Starting the attacker…");
    const text = ta.value;
    prevRun = lastRun && lastRun.text !== text ? lastRun : null;
    let started = false, finished = false;
    es = new EventSource(`/api/siege?mandate=${encodeURIComponent(text)}&generations=${GENERATIONS}`);
    es.addEventListener("start", (e) => {
      started = true;
      if (hasResult) clearBoard(true), running("Starting the attacker…");
      const s = JSON.parse(e.data);
      legit = new Set(s.legit || []);
      guards.outlayer.root.dataset.phase = "running";
      guards.outlayer.phase.textContent = `Attack round 0 of ${s.generations}`;
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
        siegeError(h.sieges >= (h.maxSieges ?? 1) ? `The attacker is busy: ${h.sieges} other sieges are running, the most it runs at once. Try again in a few seconds.` : "The server refused this siege. Check the mandate reads cleanly above, then try again.");
      } catch {
        siegeError("Can’t reach the SIEGE server. Check your connection, then try again.");
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

  // ---------- next step ----------
  // After the verdict: the weakest clause, a one-click rewrite where the findings support one, and the way to use the guard.
  function suggestFor(s) {
    if (!s.roles?.includes("open-recipients") || !legit.size || !s.findings.some((f) => f.kind === "theft")) return null;
    const who = list([...legit]);
    const cap = s.text.match(/up to ([\d.]+)\s*(NEAR)?\s*per (transaction|tx|payment|transfer)/i);
    return cap ? `Pay up to ${cap[1]} ${cap[2] || "NEAR"} per transaction to ${who}.` : `Pay only ${who}.`;
  }
  let pendingFix = null;
  function renderNext(d) {
    const losses = d.losses || {};
    const delta = $("#next-delta");
    if (prevRun) {
      const was = prevRun.losses;
      delta.textContent = `Since your edit: with the guard ${near(was.mandate ?? 0)} → ${near(losses.mandate ?? 0)} NEAR lost; without SIEGE ${near(was.outlayer ?? 0)} → ${near(losses.outlayer ?? 0)}.`;
    }
    delta.hidden = !prevRun;
    lastRun = { text: ta.value, losses };
    const scored = d.sentences.map((s) => ({ s, loss: s.findings.reduce((a, f) => a + f.loss, 0), guardLoss: s.findings.filter((f) => f.guard === "mandate").reduce((a, f) => a + f.loss, 0) }));
    // The weak point is the clause the guard itself lost on; failing that, the one that lost the most without SIEGE.
    const weak = [...scored].sort((a, b) => b.guardLoss - a.guardLoss || b.loss - a.loss)[0];
    const weakEl = $("#next-weak");
    if (!weak || weak.loss <= 0) weakEl.textContent = "No clause let money out. Use the guard as it is.";
    else if (weak.guardLoss > 0) weakEl.textContent = `Weak point: clause ${weak.s.index + 1}, “${weak.s.text}” It let ${near(weak.guardLoss)} NEAR past the guard, and ${near(weak.loss - weak.guardLoss)} without it.`;
    else weakEl.textContent = `The guard held every clause. Clause ${weak.s.index + 1} lost the most without it, ${near(weak.loss)} NEAR, so put the guard in front of your wallet.`;
    const fix = weak?.guardLoss > 0 ? suggestFor(weak.s) : null;
    pendingFix = fix ? { from: weak.s.text, to: fix } : null;
    $("#next-fix").hidden = !fix;
    if (fix) $("#next-fix-text").textContent = `Suggested: name the payees. “${fix}”`;
    $("#next").hidden = false;
  }
  $("#next-fix-btn").addEventListener("click", async () => {
    if (!pendingFix || !ta.value.includes(pendingFix.from)) return;
    ta.value = ta.value.replace(pendingFix.from, pendingFix.to);
    pendingFix = null;
    fit();
    await compile();
    laySiege();
  });
  $("#next-use").addEventListener("click", () => {
    const x = $("#export");
    x.open = true;
    x.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    $("summary", x).focus({ preventScroll: true });
  });

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
        msg.textContent = r.status === 422 ? why422(j.error) : sentence(j.error || "That did not go through");
        const bad = /amount/.test(j.error) ? "#t-amount" : /recipient/.test(j.error) ? "#t-to" : /arguments/.test(j.error) ? "#t-args" : null;
        if (bad) $(bad).setAttribute("aria-invalid", "true"), $(bad).focus();
        return;
      }
      renderVerdicts(j);
    } catch {
      msg.textContent = "Can’t reach the SIEGE server. Check your connection, then try again.";
    } finally {
      btn.removeAttribute("aria-busy");
    }
  });
  function renderVerdicts(j) {
    const box = $("#verdicts");
    box.replaceChildren();
    const says = (g) => (j[g].verdict === "allow" ? "would send it" : j[g].verdict === "deny" ? "would refuse it" : `would ${j[g].verdict} it`);
    $("#try-live").textContent = `${GUARD.outlayer} ${says("outlayer")}. ${GUARD.mandate} ${says("mandate")}.`;
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
    const sig = el("div", { class: "signals" }, el("h3", { text: `What the classifier saw, risk ${Number(j.risk).toFixed(2)}` }));
    const ul = el("ul");
    if (!j.signals?.length) ul.append(el("li", {}, el("span", { class: "w", text: "0" }), el("span", { text: "No signals" }), el("span", { class: "d", text: "Nothing about this transaction looked off." })));
    for (const s of j.signals || []) ul.append(el("li", {}, el("span", { class: "w", text: Number(s.weight).toFixed(2) }), el("span", { text: human(s.code) }), el("span", { class: "d", text: s.detail })));
    sig.append(ul);
    box.append(sig);
    box.hidden = false;
  }

  // ---------- columns ----------
  // On wide screens both columns are sticky. A column taller than the window sticks by its bottom edge, so all of it can be read.
  const cols = [$(".doc"), siegeEl];
  const wide = matchMedia("(min-width: 70.0625rem)");
  const GAP = 24;
  function stick() {
    for (const c of cols) c.style.setProperty("--stick-top", wide.matches ? `${Math.min(GAP, innerHeight - c.offsetHeight - GAP)}px` : "");
  }
  new ResizeObserver(stick).observe(cols[0]);
  new ResizeObserver(stick).observe(cols[1]);
  addEventListener("resize", () => (stick(), fit()));

  // After a dropped connection, read the mandate again once the page is back online or back in view.
  const recompile = () => !compileOk && document.visibilityState === "visible" && compile();
  addEventListener("online", recompile);
  document.addEventListener("visibilitychange", recompile);

  // ---------- start ----------
  fit();
  count();
  compile().then(() => {
    if (new URLSearchParams(location.search).get("autosiege") === "1" && compileOk) laySiege();
  });
})();
