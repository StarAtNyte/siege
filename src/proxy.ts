// SIEGE guard proxy: a drop-in, OutLayer-compatible endpoint that puts Mandate in front of an agent wallet.
//
// Point your agent at this proxy instead of https://testnet-api.outlayer.ai. Same paths, same bodies,
// same Bearer key. Add one header carrying what the agent was asked and what it read:
//   x-siege-context: base64(JSON {userInstruction, retrieved: string[], reasoning, provenance, memo})
// No context, no money: a spend without context is judged as the agent acting on its own.
//
//   MANDATE="Pay up to 5 NEAR per transaction to alice.testnet ..." npm run proxy
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { compileMandate } from "./mandate/compiler.ts";
import { MandateGuard } from "./mandate/guard.ts";
import { AtomicLedger, type Entry } from "./mandate/ledger.ts";
import type { Provenance, Tx } from "./mandate/types.ts";
import type { ExecResult, WalletAdapter } from "./adapters/wallet.ts";

export interface ProxyOptions {
  mandate: string;
  upstream?: string;
  stateDir?: string;
  fetchImpl?: typeof fetch;
}

const YOCTO_PER_MICRO = 10n ** 18n;
const GUARDED = new Set(["/wallet/v1/transfer", "/wallet/v1/call"]);
/** Endpoints that can move funds or change custody and that the guard cannot judge yet. */
const REFUSED = [/^\/wallet\/v1\/delete/, /^\/wallet\/v1\/api-key/, /^\/wallet\/v1\/intents\//, /^\/wallet\/v1\/limit-orders/, /^\/wallet\/v1\/(evm|solana)\//, /^\/wallet\/v1\/sign-message/, /^\/wallet\/v1\/auth-sign/];

function yoctoToMicro(v: unknown): number {
  if (typeof v !== "string" && typeof v !== "number") throw new Error("amount must be a yoctoNEAR string");
  const y = BigInt(String(v).split(".")[0]);
  if (y <= 0n) throw new Error("amount must be positive");
  return Number(y / YOCTO_PER_MICRO);
}

function contextFrom(header: string | string[] | undefined) {
  const empty = { userInstruction: "", retrieved: [] as string[], reasoning: "", provenance: "agent" as Provenance, memo: "" };
  if (typeof header !== "string" || !header) return { ...empty, missing: true };
  try {
    const j = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    const prov: Provenance = ["user", "retrieved", "tool_output", "agent"].includes(j.provenance) ? j.provenance : "agent";
    return {
      userInstruction: String(j.userInstruction ?? "").slice(0, 4000),
      retrieved: Array.isArray(j.retrieved) ? j.retrieved.map((x: unknown) => String(x).slice(0, 8000)).slice(0, 10) : [],
      reasoning: String(j.reasoning ?? "").slice(0, 4000),
      provenance: prov,
      memo: String(j.memo ?? "").slice(0, 200),
      missing: false,
    };
  } catch {
    return { ...empty, missing: true };
  }
}

export function createProxy(opts: ProxyOptions) {
  const upstream = (opts.upstream ?? "https://testnet-api.outlayer.ai").replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const stateDir = opts.stateDir ?? ".siege";
  fs.mkdirSync(stateDir, { recursive: true });
  const ledgerFile = path.join(stateDir, "ledger.json");
  const auditFile = path.join(stateDir, "audit.jsonl");

  const pending = new Map<string, { auth: string; path: string; body: string; response?: { status: number; text: string } }>();
  const adapter: WalletAdapter = {
    name: "outlayer-forward",
    async execute(tx: Tx): Promise<ExecResult> {
      const p = pending.get(tx.id)!;
      try {
        const r = await doFetch(`${upstream}${p.path}`, { method: "POST", headers: { authorization: p.auth, "content-type": "application/json" }, body: p.body });
        p.response = { status: r.status, text: await r.text() };
        return r.ok ? { ok: true } : { ok: false, error: `upstream ${r.status}` };
      } catch (e) {
        p.response = { status: 502, text: JSON.stringify({ error: "upstream_unreachable", detail: (e as Error).message }) };
        return { ok: false, error: "upstream unreachable" };
      }
    },
  };
  const ledger = new AtomicLedger();
  try {
    ledger.restore(JSON.parse(fs.readFileSync(ledgerFile, "utf8")) as Entry[]);
  } catch {
    /* first run */
  }
  ledger.onChange = (entries) => {
    fs.writeFileSync(ledgerFile + ".tmp", JSON.stringify(entries));
    fs.renameSync(ledgerFile + ".tmp", ledgerFile); // atomic replace
  };
  const guard = new MandateGuard(compileMandate(opts.mandate), { adapter, ledger });
  const audit = (rec: Record<string, unknown>) => fs.appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n");
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const reply = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof data === "string" ? data : JSON.stringify(data));
    };
    try {
      if (url.pathname === "/siege/healthz") return reply(200, { ok: true, mandate: opts.mandate });
      if (REFUSED.some((r) => r.test(url.pathname))) {
        audit({ route: url.pathname, verdict: "refused" });
        return reply(403, { error: "refused_by_guard", detail: "this endpoint can move funds or change custody and is not permitted through the SIEGE guard" });
      }
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ")) return reply(401, { error: "missing Bearer api key" });

      if (req.method === "GET") {
        const r = await doFetch(`${upstream}${url.pathname}${url.search}`, { headers: { authorization: auth } });
        res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
        return res.end(await r.text());
      }
      if (req.method !== "POST" || !GUARDED.has(url.pathname)) return reply(404, { error: "not found through the guard" });

      let raw = "";
      for await (const c of req) {
        raw += c;
        if (raw.length > 100_000) return reply(413, { error: "body too large" });
      }
      const b = JSON.parse(raw || "{}");
      const ctx = contextFrom(req.headers["x-siege-context"]);
      const isCall = url.pathname.endsWith("/call");
      const id = `px${Date.now()}-${++seq}`;
      const amountMicro = isCall ? (b.deposit && b.deposit !== "0" ? yoctoToMicro(b.deposit) : 0) : yoctoToMicro(b.amount);
      const tx: Tx = {
        id, agentId: "outlayer-wallet", kind: isCall ? "call" : "transfer", token: "NEAR",
        amount: Math.max(1, amountMicro), recipient: String(isCall ? b.receiver_id : b.to ?? "").toLowerCase(),
        method: isCall ? String(b.method_name ?? "") : undefined, args: isCall ? b.args : undefined,
        memo: ctx.memo, timestampMs: Date.now(),
        context: { userInstruction: ctx.userInstruction, retrieved: ctx.retrieved, reasoning: ctx.reasoning, provenance: ctx.provenance },
      };
      pending.set(id, { auth, path: url.pathname, body: raw });
      try {
        const d = await guard.submit(tx);
        const p = pending.get(id)!;
        audit({ route: url.pathname, to: tx.recipient, method: tx.method, amountNear: tx.amount / 1e6, verdict: d.verdict, stage: d.stage, reasons: d.reasons, risk: d.risk, contextMissing: ctx.missing, upstream: p.response?.status });
        if (d.verdict === "allow") return reply(p.response!.status, p.response!.text);
        if (p.response) return reply(p.response.status, p.response.text); // upstream refused; reservation released
        return reply(403, { error: "mandate_denied", stage: d.stage, reasons: d.reasons, hint: ctx.missing ? "send x-siege-context with the user's instruction and what the agent read" : undefined });
      } finally {
        pending.delete(id);
      }
    } catch (e) {
      return reply(400, { error: (e as Error).message });
    }
  });
  return { server, guard };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mandate = process.env.MANDATE ?? (process.env.MANDATE_FILE ? fs.readFileSync(process.env.MANDATE_FILE, "utf8") : "");
  if (!mandate.trim()) {
    console.error("Set MANDATE (or MANDATE_FILE) to your plain-language mandate.");
    process.exit(2);
  }
  const { server } = createProxy({ mandate, upstream: process.env.UPSTREAM, stateDir: process.env.SIEGE_STATE_DIR });
  const port = Number(process.env.PORT ?? 8687), host = process.env.HOST ?? "127.0.0.1";
  server.listen(port, host, () => console.log(`SIEGE guard proxy on http://${host}:${port} -> ${process.env.UPSTREAM ?? "https://testnet-api.outlayer.ai"}`));
}
