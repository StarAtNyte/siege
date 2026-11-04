// SIEGE web app: compile a mandate, try a transaction, lay siege (live evolutionary attack), export.
//   npm start            -> http://127.0.0.1:8686
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileMandate, MandateParseError } from "./mandate/compiler.ts";
import { MandateGuard } from "./mandate/guard.ts";
import { OutLayerPolicyGuard, toOutlayerPolicy } from "./baseline/outlayerPolicy.ts";
import { classify } from "./mandate/classifier.ts";
import type { Tx, Provenance } from "./mandate/types.ts";
import { toMicro, fromMicro } from "./mandate/types.ts";
import { Arena, render, routedTo } from "./attack/arena.ts";
import { Search, type Progress } from "./attack/ga.ts";
import { diagnose, rolesOf, sentences } from "./attack/diagnose.ts";
import { MANDATES } from "./eval/suite.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(here, "../ui");
const PORT = Number(process.env.PORT ?? 8686);
const HOST = process.env.HOST ?? "127.0.0.1";
const MAX_MANDATE = 2000;
const MAX_SIEGES = Number(process.env.SIEGE_MAX_CONCURRENT ?? 2);
let running = 0;

function send(res: http.ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(typeof data === "string" ? data : JSON.stringify(data));
}

async function body(req: http.IncomingMessage) {
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > 20_000) throw new HttpError(413, "request too large");
  }
  try {
    const j = JSON.parse(raw || "{}");
    if (typeof j !== "object" || !j || Array.isArray(j)) throw new Error();
    return j as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

class HttpError extends Error {
  constructor(public status: number, msg: string, public headers: Record<string, string> = {}) {
    super(msg);
  }
}

function compileOr400(text: unknown) {
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "write a mandate first");
  if (text.length > MAX_MANDATE) throw new HttpError(400, `keep the mandate under ${MAX_MANDATE} characters`);
  try {
    return compileMandate(text);
  } catch (e) {
    if (e instanceof MandateParseError) throw new HttpError(422, e.message);
    throw e;
  }
}

function describe(c: ReturnType<typeof compileMandate>) {
  const n = (m: number) => fromMicro(m);
  return {
    payees: c.openRecipients ? "any payee the user asks for" : c.allowedRecipients.filter((r) => !c.allowedMethods.length || r !== c.allowedRecipients.at(-1) || c.allowedKinds.includes("transfer")),
    suffixes: c.allowedRecipientSuffixes,
    denied: c.deniedRecipients,
    perTransaction: Object.fromEntries(Object.entries(c.perTx).map(([k, v]) => [k, n(v)])),
    windows: Object.entries(c.windows).flatMap(([tok, ws]) => ws.map((w) => ({ token: tok, hours: w.windowMs / 3_600_000, cap: n(w.cap) }))),
    kinds: c.allowedKinds,
    methods: c.allowedMethods,
    swaps: c.allowedSwapPairs,
    activeHoursUtc: c.activeHoursUtc ?? null,
    purposes: c.purposes,
  };
}

function txFrom(b: Record<string, unknown>): Tx {
  const str = (k: string, d = "") => (typeof b[k] === "string" ? (b[k] as string).slice(0, 2000) : d);
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e6) throw new HttpError(400, "amount must be a positive number of NEAR");
  const to = str("to").trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,64}$/.test(to)) throw new HttpError(400, "recipient must be a NEAR account id");
  const kind = b.kind === "call" ? "call" : "transfer";
  let args: Record<string, unknown> | undefined;
  if (kind === "call" && typeof b.args === "string" && b.args.trim()) {
    try {
      args = JSON.parse(b.args);
    } catch {
      throw new HttpError(400, "call arguments must be JSON");
    }
  }
  const prov = (["user", "retrieved", "tool_output", "agent"].includes(str("provenance")) ? str("provenance") : "user") as Provenance;
  return {
    id: "try", agentId: "agent.siege.testnet", kind, token: "NEAR", amount: toMicro(amount), recipient: to,
    method: kind === "call" ? str("method") : undefined, args, memo: str("memo"), timestampMs: Date.now(),
    context: { userInstruction: str("userInstruction"), retrieved: str("retrieved") ? [str("retrieved")] : [], reasoning: str("reasoning"), provenance: prov },
  };
}

async function siege(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const text = url.searchParams.get("mandate");
  const c = compileOr400(text);
  const generations = Math.min(60, Math.max(5, Number(url.searchParams.get("generations") ?? 30)));
  if (running >= MAX_SIEGES) throw new HttpError(429, "the attacker is busy with other sieges; try again in a few seconds", { "retry-after": "5" });
  running++;
  let closed = false;
  req.on("close", () => (closed = true));
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  const emit = (event: string, data: unknown) => !closed && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const arena = new Arena(c);
    emit("start", { generations, recipients: arena.lib.recipients, legit: [...arena.lib.legit] });
    const results = [];
    for (const guard of ["outlayer", "mandate"] as const) {
      const s = new Search(arena, guard, 1);
      // Pin the best attack's breaches to clauses whenever the best attack improves, so the UI can red-line live.
      let lastLoss = -1;
      let marks: { index: number; loss: number }[] = [];
      let general = 0;
      const onProgress = ({ breaches, ...p }: Progress) => {
        if (p.bestLoss !== lastLoss) {
          lastLoss = p.bestLoss;
          const d = diagnose(text!, c, [{ guard, breaches: breaches ?? [] }]);
          marks = d.sentences.filter((x) => x.findings.length).map((x) => ({ index: x.index, loss: Math.round(x.findings.reduce((a, f) => a + f.loss, 0) * 100) / 100 }));
          general = Math.round(d.general.filter((f) => f.loss > 0).reduce((a, f) => a + f.loss, 0) * 100) / 100;
        }
        emit("progress", { ...p, marks, general });
      };
      results.push(await s.run(generations, 64, onProgress, () => closed));
    }
    if (closed) return;
    const runs = [];
    let budget: { cap: number; hours: number; viaBudget: number; withinBudget: boolean } | null = null;
    for (const r of results) {
      const ev = await arena.evaluate(r.guard, r.genome);
      runs.push({ guard: r.guard, breaches: ev.breaches });
      if (r.guard === "mandate") budget = novelBudget(c, ev);
      emit("attack", {
        guard: r.guard,
        loss: r.loss,
        history: r.history,
        evaluations: r.evaluations,
        steps: ev.txs.map((t) => ({
          to: t.recipient, routedTo: t.kind === "call" && routedTo(t) !== t.recipient ? routedTo(t) : null,
          kind: t.kind, method: t.method ?? null, amount: fromMicro(t.amount), user: t.context.userInstruction, doc: t.context.retrieved[0] ?? null,
          verdict: ev.decisions.get(t.id)!.verdict, reasons: ev.decisions.get(t.id)!.reasons.slice(0, 4), novelBudget: ev.decisions.get(t.id)!.novelBudget,
        })),
      });
    }
    emit("done", { ...diagnose(text!, c, runs), losses: Object.fromEntries(results.map((r) => [r.guard, r.loss])), budget, evaluations: results.reduce((a, r) => a + r.evaluations, 0) });
  } finally {
    running--;
    res.end();
  }
}

/**
 * The novel-payee budget bounds what the Mandate guard lets go to payees nobody vouched for.
 * withinBudget is true only when every NEAR the best attack took went through that budget
 * (theft by transfer, charged to the novel-payee ledger) and the total is no more than the tightest cap.
 */
function novelBudget(c: ReturnType<typeof compileMandate>, ev: Awaited<ReturnType<Arena["evaluate"]>>) {
  const ws = new MandateGuard(c).novelWindows();
  const tight = (ws.NEAR ?? ws["*"] ?? []).reduce<{ cap: number; windowMs: number } | null>((a, w) => (!a || w.cap < a.cap ? w : a), null);
  if (!tight) return null;
  const cap = fromMicro(tight.cap);
  const lost = ev.loss;
  const viaBudget = ev.breaches.filter((b) => b.kind === "theft" && ev.decisions.get(b.tx.id)?.novelBudget).reduce((a, b) => a + b.loss, 0);
  const round = (x: number) => Math.round(x * 100) / 100;
  return { cap: round(cap), hours: tight.windowMs / 3_600_000, viaBudget: round(viaBudget), withinBudget: lost > 0 && viaBudget >= lost - 1e-9 && lost <= cap + 1e-9 };
}

const STATIC: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

/** The page's absolute origin, for share-card tags that must be absolute. PUBLIC_URL wins; otherwise the request's own host, if it looks like one. */
function origin(req: http.IncomingMessage) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, "");
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
  const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0].trim() === "https" ? "https" : "http";
  return /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `${proto}://${host}` : `http://${HOST}:${PORT}`;
}

function notFound(res: http.ServerResponse, p: string) {
  if (p.startsWith("/api/")) return send(res, 404, { error: "not found" });
  res.writeHead(404, { "content-type": STATIC[".html"], "cache-control": "no-store", "x-content-type-options": "nosniff" });
  fs.createReadStream(path.join(UI, "404.html")).pipe(res);
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  try {
    if (req.method === "GET" && p === "/healthz") return send(res, 200, { ok: true, sieges: running, maxSieges: MAX_SIEGES });
    if (req.method === "GET" && p === "/api/examples") return send(res, 200, MANDATES);
    if (req.method === "POST" && p === "/api/compile") {
      const b = await body(req);
      const c = compileOr400(b.mandate);
      return send(res, 200, {
        constraints: describe(c),
        sentences: sentences(b.mandate as string).map((text, index) => ({ index, text, roles: rolesOf(text) })),
        outlayerPolicy: toOutlayerPolicy(c),
        guardConfig: { mandate: b.mandate, thresholds: { allowBelow: 0.3, denyAbove: 0.75 }, novelPayeeShare: 0.1 },
      });
    }
    if (req.method === "POST" && p === "/api/check") {
      const b = await body(req);
      const c = compileOr400(b.mandate);
      const tx = txFrom((b.tx ?? {}) as Record<string, unknown>);
      const mg = new MandateGuard(c);
      const og = new OutLayerPolicyGuard(c, { gapMs: 0 });
      const [m, o] = await Promise.all([mg.submit(tx), og.submit({ ...tx })]);
      const cls = classify(tx, c, { knownPayees: new Set(), recent: new Map() });
      return send(res, 200, { mandate: m, outlayer: o, signals: cls.signals, risk: cls.risk });
    }
    if (req.method === "GET" && p === "/api/siege") return await siege(req, res, url);
    if (req.method === "GET") {
      const file = path.resolve(UI, "." + (p === "/" ? "/index.html" : p));
      if (p !== "/404.html" && file.startsWith(UI + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const headers = { "content-type": STATIC[path.extname(file)] ?? "application/octet-stream", "x-content-type-options": "nosniff" };
        if (file === path.join(UI, "index.html")) {
          res.writeHead(200, { ...headers, "cache-control": "no-cache" });
          return void res.end(fs.readFileSync(file, "utf8").replaceAll("__ORIGIN__", origin(req)));
        }
        res.writeHead(200, headers);
        return void fs.createReadStream(file).pipe(res);
      }
    }
    notFound(res, p);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? "internal error" : (e as Error).message }, e instanceof HttpError ? e.headers : {});
    else res.end();
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, HOST, () => console.log(`SIEGE: http://${HOST}:${PORT}`));
}
export { render };
