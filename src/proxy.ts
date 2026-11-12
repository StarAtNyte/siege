// SIEGE guard proxy: a drop-in, OutLayer-compatible endpoint that puts Mandate in front of an agent wallet.
//
// Point your agent at this proxy instead of https://testnet-api.outlayer.ai. Same paths, same bodies. Key custody
// stays here: the proxy holds the OutLayer API key (OUTLAYER_API_KEY) and the agent authenticates with a
// proxy-issued token (SIEGE_PROXY_TOKEN) that is worthless anywhere else. A request that carries an OutLayer key is
// rejected, so an agent that still has one is told to rotate it. Add one header carrying what the agent was asked
// and what it read:
//   x-siege-context: base64(JSON {userInstruction, retrieved: string[], reasoning, provenance, memo})
// No context, no money: a spend without context is judged as the agent acting on its own.
//
// Vault mode (VAULT_CONTRACT set): spends go to the two-key vault contract instead of OutLayer. The guard signs an
// approval only for spends Mandate allows; POST /wallet/v1/transfer relays spend() with the agent's function-call
// key, and POST /siege/v1/approve hands the signed approval back for an agent that submits spend() itself.
//
//   SIEGE_PROXY_TOKEN=... OUTLAYER_API_KEY=... MANDATE="Pay up to 5 NEAR per transaction to alice.testnet ..." npm run proxy
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { compileMandate } from "./mandate/compiler.ts";
import { MandateGuard } from "./mandate/guard.ts";
import { AtomicLedger, type Entry } from "./mandate/ledger.ts";
import type { Provenance, Tx } from "./mandate/types.ts";
import type { ExecResult, WalletAdapter } from "./adapters/wallet.ts";
import type { VaultWallet } from "./adapters/vault.ts";
import type { SignedApproval } from "./vault/approval.ts";

export interface ProxyOptions {
  mandate: string;
  /** Token the proxy issued to the agent; the agent sends it as its Bearer key. */
  agentToken: string;
  /** The OutLayer API key. Held only by the proxy; required unless `vault` is set. */
  upstreamKey?: string;
  /** Two-key vault mode: spends are signed by the guard and paid by the vault contract instead of OutLayer. */
  vault?: VaultWallet;
  upstream?: string;
  stateDir?: string;
  fetchImpl?: typeof fetch;
}

const YOCTO_PER_MICRO = 10n ** 18n;
const GUARDED = new Set(["/wallet/v1/transfer", "/wallet/v1/call"]);
/** Endpoints that can move funds or change custody and that the guard cannot judge yet. */
const REFUSED = [/^\/wallet\/v1\/delete/, /^\/wallet\/v1\/api-key/, /^\/wallet\/v1\/intents\//, /^\/wallet\/v1\/limit-orders/, /^\/wallet\/v1\/(evm|solana)\//, /^\/wallet\/v1\/sign-message/, /^\/wallet\/v1\/auth-sign/];

/** OutLayer agent-wallet API keys look like `wk_...`. */
const OUTLAYER_KEY_SHAPE = /\bwk_[A-Za-z0-9]{8,}/;

function sameToken(a: string, b: string) {
  const x = crypto.createHash("sha256").update(a).digest(), y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

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
  if (!opts.agentToken || opts.agentToken.length < 16) throw new Error("agentToken must be at least 16 characters");
  if (!opts.vault && !opts.upstreamKey) throw new Error("the proxy needs the OutLayer API key (upstreamKey) unless it runs in vault mode");
  if (opts.upstreamKey && sameToken(opts.upstreamKey, opts.agentToken)) throw new Error("the agent token must not be the OutLayer key");
  const carriesUpstreamKey = (s: string) => (!!opts.upstreamKey && s.includes(opts.upstreamKey)) || OUTLAYER_KEY_SHAPE.test(s);
  const upstreamAuth = `Bearer ${opts.upstreamKey ?? ""}`;
  const upstream = (opts.upstream ?? "https://testnet-api.outlayer.ai").replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const stateDir = opts.stateDir ?? ".siege";
  fs.mkdirSync(stateDir, { recursive: true });
  const ledgerFile = path.join(stateDir, "ledger.json");
  const auditFile = path.join(stateDir, "audit.jsonl");

  type Mode = "forward" | "relay" | "approve";
  const pending = new Map<string, { mode: Mode; path: string; body: string; response?: { status: number; text: string }; approval?: SignedApproval }>();
  const adapter: WalletAdapter = {
    name: opts.vault ? "siege-vault" : "outlayer-forward",
    async execute(tx: Tx): Promise<ExecResult> {
      const p = pending.get(tx.id)!;
      if (p.mode === "approve") {
        try {
          p.approval = opts.vault!.approve(tx);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      }
      if (p.mode === "relay") {
        const r = await opts.vault!.execute(tx);
        p.response = r.ok ? { status: 200, text: JSON.stringify({ tx_hash: r.ref }) } : { status: 502, text: JSON.stringify({ error: "vault_refused", detail: r.error }) };
        return r;
      }
      try {
        const r = await doFetch(`${upstream}${p.path}`, { method: "POST", headers: { authorization: upstreamAuth, "content-type": "application/json" }, body: p.body });
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
      let raw = "";
      for await (const c of req) {
        raw += c;
        if (raw.length > 100_000) return reply(413, { error: "body too large" });
      }
      // Key custody: the OutLayer key lives here, never in the agent. An agent that still holds one is refused.
      const headerText = Object.entries(req.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(",") : v ?? ""}`).join("\n");
      if (carriesUpstreamKey(headerText) || carriesUpstreamKey(url.search) || carriesUpstreamKey(raw)) {
        audit({ route: url.pathname, verdict: "outlayer_key_rejected" });
        return reply(403, { error: "outlayer_key_rejected", detail: "requests must not carry an OutLayer API key; authenticate with your SIEGE proxy token and rotate the exposed OutLayer key" });
      }
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ") || !sameToken(auth.slice(7), opts.agentToken)) return reply(401, { error: "missing or invalid SIEGE proxy token" });

      if (req.method === "GET") {
        if (opts.vault || !url.pathname.startsWith("/wallet/v1/")) return reply(404, { error: "not found through the guard" });
        const r = await doFetch(`${upstream}${url.pathname}${url.search}`, { headers: { authorization: upstreamAuth } });
        res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
        return res.end(await r.text());
      }
      const approveRoute = url.pathname === "/siege/v1/approve";
      if (req.method !== "POST" || !(GUARDED.has(url.pathname) || (approveRoute && opts.vault))) return reply(404, { error: "not found through the guard" });
      if (opts.vault && url.pathname === "/wallet/v1/call") return reply(403, { error: "refused_by_guard", detail: "the vault pays NEAR transfers only" });
      const mode: Mode = !opts.vault ? "forward" : approveRoute ? "approve" : "relay";

      const b = JSON.parse(raw || "{}");
      const ctx = contextFrom(req.headers["x-siege-context"]);
      const isCall = url.pathname.endsWith("/call");
      const id = `px${Date.now()}-${++seq}`;
      const amountMicro = isCall ? (b.deposit && b.deposit !== "0" ? yoctoToMicro(b.deposit) : 0) : yoctoToMicro(b.amount);
      if (!isCall && BigInt(String(b.amount).split(".")[0]) % YOCTO_PER_MICRO !== 0n) throw new Error("amount must be a whole number of micro-NEAR (1e18 yocto)");
      const tx: Tx = {
        id, agentId: "outlayer-wallet", kind: isCall ? "call" : "transfer", token: "NEAR",
        amount: Math.max(1, amountMicro), recipient: String(isCall ? b.receiver_id : b.to ?? b.receiver ?? "").toLowerCase(),
        method: isCall ? String(b.method_name ?? "") : undefined, args: isCall ? b.args : undefined,
        memo: ctx.memo, timestampMs: Date.now(),
        context: { userInstruction: ctx.userInstruction, retrieved: ctx.retrieved, reasoning: ctx.reasoning, provenance: ctx.provenance },
      };
      pending.set(id, { mode, path: url.pathname, body: raw });
      try {
        const d = await guard.submit(tx);
        const p = pending.get(id)!;
        audit({ route: url.pathname, to: tx.recipient, method: tx.method, amountNear: tx.amount / 1e6, verdict: d.verdict, stage: d.stage, reasons: d.reasons, risk: d.risk, contextMissing: ctx.missing, upstream: p.response?.status, approvalNonce: p.approval?.nonce });
        if (d.verdict === "allow" && p.approval) return reply(200, { approval: p.approval, vault: opts.vault!.target });
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
  const agentToken = process.env.SIEGE_PROXY_TOKEN ?? "";
  if (agentToken.length < 16) {
    console.error("Set SIEGE_PROXY_TOKEN (16+ chars, e.g. `openssl rand -hex 24`) and give that token, not your OutLayer key, to the agent.");
    process.exit(2);
  }
  let vault: VaultWallet | undefined;
  if (process.env.VAULT_CONTRACT) {
    const { VaultWallet } = await import("./adapters/vault.ts");
    const { GuardSigner } = await import("./vault/approval.ts");
    const { nearSubmit } = await import("./vault/near.ts");
    const { Account, JsonRpcProvider } = await import("near-api-js");
    const id = process.env.VAULT_CONTRACT, network = process.env.VAULT_NETWORK ?? "testnet";
    if (!process.env.GUARD_KEY || !process.env.VAULT_AGENT_KEY) {
      console.error("Vault mode needs GUARD_KEY (the guard's ed25519 secret) and VAULT_AGENT_KEY (the agent's function-call key on the vault).");
      process.exit(2);
    }
    const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC ?? `https://rpc.${network}.near.org` });
    const agent = new Account(process.env.VAULT_AGENT ?? id, provider, process.env.VAULT_AGENT_KEY as `ed25519:${string}`);
    vault = new VaultWallet(new GuardSigner(process.env.GUARD_KEY), { contractId: id, network }, nearSubmit(agent, id));
  } else if (!process.env.OUTLAYER_API_KEY) {
    console.error("Set OUTLAYER_API_KEY: the proxy holds it, the agent never sees it (or set VAULT_CONTRACT for vault mode).");
    process.exit(2);
  }
  const { server } = createProxy({ mandate, agentToken, upstreamKey: process.env.OUTLAYER_API_KEY, vault, upstream: process.env.UPSTREAM, stateDir: process.env.SIEGE_STATE_DIR });
  const port = Number(process.env.PORT ?? 8687), host = process.env.HOST ?? "127.0.0.1";
  const target = vault ? `vault ${vault.target.contractId} (${vault.target.network})` : process.env.UPSTREAM ?? "https://testnet-api.outlayer.ai";
  server.listen(port, host, () => console.log(`SIEGE guard proxy on http://${host}:${port} -> ${target}`));
}
