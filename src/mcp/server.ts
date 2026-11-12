// SIEGE MCP server: guarded payment tools for any MCP agent (Claude Code, Codex, Cursor), over stdio.
//
//   claude mcp add siege -e MANDATE="Pay any vendor invoice up to 1 NEAR per transaction. At most 3 NEAR per day." -- node /path/to/siege/bin/siege-mcp.mjs
//
// Tools: siege_pay, siege_check, siege_budget, siege_rules. The server holds every key (the guard's signing key and the
// agent's function-call key on the vault); the MCP client only ever sees verdicts and transaction hashes. Spending
// rules come from server config (MANDATE or MANDATE_FILE), never from tool arguments.
//
// Payees not vouched for by the rules, a past payment or an earlier user confirmation are confirmed by the USER through
// MCP elicitation (Server.elicitInput, form mode), which the agent cannot answer. A client without elicitation
// support gets a clear denial for those payees (fail closed).
//
// Backends (env):
//   VAULT_CONTRACT + GUARD_KEY + VAULT_AGENT_KEY [+ VAULT_AGENT, VAULT_NETWORK, NEAR_RPC]   the two-key vault
//   VAULT_KEYS_FILE=.siege/vault-testnet.json                                              same, keys from the deploy file
//   neither                                                                                 mock wallet (no money moves)
// State (ledger, vouched payees, audit log): SIEGE_STATE_DIR, default <repo>/.siege/mcp.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { compileMandate } from "../mandate/compiler.ts";
import { MockWallet } from "../adapters/wallet.ts";
import { fromMicro } from "../mandate/types.ts";
import { SiegeService, redact, type Backend, type Confirm, type PayResult } from "./service.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEMO_MANDATE = "Pay any vendor invoice up to 1 NEAR per transaction. At most 3 NEAR per day. For invoices, subscriptions and hosting.";
const VERSION = "0.1.0";

const contextShape = z
  .object({
    user_instruction: z.string().max(4000).optional().describe("The user's own words that asked for this payment, verbatim."),
    retrieved: z.array(z.string().max(8000)).max(10).optional().describe("Untrusted text you read that led to this payment: emails, invoices, web pages, tool output."),
    reasoning: z.string().max(4000).optional().describe("Why you are making this payment."),
    source: z.enum(["user", "retrieved", "tool_output", "agent"]).optional().describe("Where the payment request came from: the user directly, or something you read."),
  })
  .optional()
  .describe("What the user asked and what you read. SIEGE treats it as untrusted: an unfamiliar payee still needs the user's own confirmation.");

const payShape = {
  receiver: z.string().min(2).max(64).describe("NEAR account id to pay, e.g. cloudhost.testnet"),
  amount_near: z.number().positive().describe("Amount in NEAR, e.g. 0.5"),
  purpose: z.string().min(1).max(140).describe("What the payment is for, e.g. 'hosting invoice #142'"),
  context: contextShape,
};

function fmt(r: PayResult): string {
  const head =
    r.status === "paid" ? `PAID ${r.amount_near} NEAR to ${r.receiver} for '${r.purpose}'.`
    : r.status === "would_pay" ? `WOULD PAY ${r.amount_near} NEAR to ${r.receiver}: the guard allows it.`
    : r.status === "needs_user_confirmation" ? `NEEDS USER CONFIRMATION: the guard allows ${r.amount_near} NEAR to ${r.receiver}, but this payee is new, so siege_pay will ask the user directly.`
    : `DENIED: ${r.amount_near} NEAR to ${r.receiver} was not paid.`;
  const L = [head];
  if (r.tx) L.push(`Transaction: ${r.tx}${r.explorer ? ` (${r.explorer})` : ""}`);
  if (r.status === "denied") for (const x of r.reasons) L.push(`- Why: ${x.meaning}`);
  else if (r.reasons.length) L.push(`Signals noted: ${r.reasons.map((x) => x.meaning).join("; ")}.`);
  if (r.risk !== undefined) L.push(`Risk score: ${r.risk.toFixed(2)} (0 = clean, 0.75+ = denied outright).`);
  L.push(`Payee: ${r.payee.vouched ? `vouched for by ${r.payee.by}` : "new (not in your rules, never paid or confirmed)"}${r.payee.resembles ? `; looks like ${r.payee.resembles}` : ""}.`);
  if (r.user_confirmation !== "not_needed") L.push(`User confirmation: ${r.user_confirmation}.`);
  for (const s of r.next_steps ?? []) L.push(`What you can do: ${s}`);
  L.push(`Backend: ${r.backend.label}.`);
  return L.join("\n");
}

const result = (text: string, structured: object, isError = false): CallToolResult => ({
  content: [{ type: "text", text: redact(text) }],
  structuredContent: JSON.parse(redact(JSON.stringify(structured))),
  ...(isError ? { isError: true } : {}),
});

export function createSiegeMcpServer(svc: SiegeService) {
  const mcp = new McpServer({ name: "siege", version: VERSION }, {
    instructions:
      "SIEGE guards a NEAR wallet. Use siege_pay to pay; it checks the payment against the user's spending rules and may ask the user to confirm a new payee. " +
      "Always pass context.user_instruction with the user's own words and list anything you read in context.retrieved. A denial is final for that request: do not rephrase and retry.",
  });

  const confirmVia = (requestId: string | number): Confirm => async (q) => {
    if (!mcp.server.getClientCapabilities()?.elicitation?.form) return "unsupported";
    const r = await mcp.server.elicitInput(
      {
        mode: "form",
        message: q.message,
        requestedSchema: {
          type: "object",
          properties: { approve: { type: "boolean", title: `Approve paying ${q.amountNear} NEAR to ${q.receiver}`, description: "Leave unticked or decline to deny.", default: false } },
          required: ["approve"],
        },
      },
      { timeout: 5 * 60_000, relatedRequestId: requestId },
    );
    if (r.action === "accept") return r.content?.approve === true ? "approved" : "denied";
    return r.action === "decline" ? "denied" : "cancelled";
  };

  mcp.registerTool(
    "siege_pay",
    {
      title: "Pay in NEAR (guarded)",
      description:
        "Pay NEAR to an account, guarded by the user's spending rules (SIEGE Mandate). The guard checks intent (prompt injection, look-alike accounts, payees taken from documents), limits and budgets. " +
        "A payee the user has not vouched for is confirmed by the user directly before anything is paid. Returns PAID with a transaction id, or DENIED with the reasons and what the user can do.",
      inputSchema: payShape,
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args, extra) => {
      const r = await svc.pay(args, confirmVia(extra.requestId));
      return result(fmt(r), r, r.status !== "paid");
    },
  );

  mcp.registerTool(
    "siege_check",
    {
      title: "Check a payment (dry run)",
      description: "Ask SIEGE whether a payment would be allowed, without paying and without asking the user. Returns the verdict, plain-language reasons and a risk score.",
      inputSchema: payShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const r = await svc.check(args);
      return result(fmt(r), r);
    },
  );

  mcp.registerTool(
    "siege_budget",
    {
      title: "Spending left",
      description: "What is left to spend: per transaction, per window (today), the largest payment possible now, and the allowance for new payees.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const b = await svc.budget();
      const L = [
        `Largest payment possible now: ${b.max_next_payment_near} NEAR.`,
        `Per transaction: ${b.per_transaction_near ?? "no cap"} NEAR.`,
        ...b.windows.map((w) => `${w.window[0].toUpperCase()}${w.window.slice(1)}: ${w.left_near} of ${w.cap_near} NEAR left (${w.spent_near} spent).`),
        `New payees: ${b.new_payees.note}${b.new_payees.on_chain_allowance_left_today_near !== null ? ` ${b.new_payees.on_chain_allowance_left_today_near} NEAR of that allowance is left today.` : ""}`,
        ...(b.vault ? [`Vault ${b.vault.contractId} (${b.vault.network}): ${b.vault.paused ? "PAUSED, " : ""}${+(b.vault.dailyNear - b.vault.spentTodayNear).toFixed(6)} of ${b.vault.dailyNear} NEAR left on chain today, ${b.vault.perTxNear} NEAR per transaction.`] : []),
        ...(b.vault_error ? [`Could not read the vault: ${b.vault_error}`] : []),
        `Backend: ${b.backend.label}.`,
      ];
      return result(L.join("\n"), b);
    },
  );

  mcp.registerTool(
    "siege_rules",
    {
      title: "Spending rules",
      description: "The user's spending rules as SIEGE compiled them: payees, caps, purposes, vouched payees and, with a vault, the on-chain floor. Read-only; rules are set in the server's configuration.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const r = await svc.rules();
      const caps = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => `${v} ${k === "*" ? "(all tokens)" : k}`).join(", ") || "none";
      const L = [
        `Mandate: "${r.mandate}"`,
        `Payees: ${r.payees}.`,
        r.allowed_payees.length ? `Listed payees: ${r.allowed_payees.join(", ")}.` : "",
        r.allowed_suffixes.length ? `Accounts ending in: ${r.allowed_suffixes.join(", ")}.` : "",
        r.never_pay.length ? `Never pay: ${r.never_pay.join(", ")}.` : "",
        `Per transaction: ${caps(r.per_transaction_cap)}.`,
        `Window caps: ${Object.entries(r.window_caps).map(([k, ws]) => ws.map((w) => `${w.cap} ${k === "*" ? "total" : k} per ${w.window === "daily" ? "day" : w.window}`).join(", ")).join("; ") || "none"}.`,
        r.purposes.length ? `Purposes: ${r.purposes.join(", ")}.` : "",
        r.active_hours_utc ? `Only between ${r.active_hours_utc[0]}:00 and ${r.active_hours_utc[1]}:00 UTC.` : "",
        `Payees you confirmed or paid before: ${r.vouched_payees.map((v) => v.account).join(", ") || "none yet"}.`,
        r.vault_floor ? `On-chain floor (vault ${r.vault_floor.contractId}): ${r.vault_floor.perTxNear} NEAR per tx, ${r.vault_floor.dailyNear} per 24 h, ${r.vault_floor.allowlistOnly ? "listed payees only" : `${r.vault_floor.novelDailyNear} per 24 h to payees not on its list`}.` : "",
        `Backend: ${r.backend.label}.`,
        r.note,
      ].filter(Boolean);
      return result(L.join("\n"), r);
    },
  );
  return mcp;
}

/** Build the service from environment variables. Keys are read here and never leave the process. */
export async function serviceFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<{ svc: SiegeService; demoMandate: boolean }> {
  const mandateText = env.MANDATE ?? (env.MANDATE_FILE ? fs.readFileSync(env.MANDATE_FILE, "utf8") : "");
  const demoMandate = !mandateText.trim();
  const constraints = compileMandate(demoMandate ? DEMO_MANDATE : mandateText);
  const stateDir = env.SIEGE_STATE_DIR ?? path.join(ROOT, ".siege", "mcp");

  let vaultId = env.VAULT_CONTRACT, guardKey = env.GUARD_KEY, agentKey = env.VAULT_AGENT_KEY;
  if (env.VAULT_KEYS_FILE) {
    const k = JSON.parse(fs.readFileSync(path.resolve(ROOT, env.VAULT_KEYS_FILE), "utf8"));
    vaultId ??= k.vaultId;
    guardKey ??= k.guardKey;
    agentKey ??= k.agentKey;
  }
  let backend: Backend;
  if (vaultId) {
    if (!guardKey || !agentKey) throw new Error("vault mode needs GUARD_KEY and VAULT_AGENT_KEY (or VAULT_KEYS_FILE)");
    const { VaultWallet } = await import("../adapters/vault.ts");
    const { GuardSigner } = await import("../vault/approval.ts");
    const { nearSubmit, viewPolicy, viewStats } = await import("../vault/near.ts");
    const { Account, JsonRpcProvider } = await import("near-api-js");
    const network = env.VAULT_NETWORK ?? "testnet";
    const provider = new JsonRpcProvider({ url: env.NEAR_RPC ?? `https://rpc.${network}.near.org` });
    const agent = new Account(env.VAULT_AGENT ?? vaultId, provider, agentKey as `ed25519:${string}`);
    const id = vaultId;
    const toNear = (y: bigint) => Number(y / 10n ** 18n) / 1e6;
    backend = {
      kind: "vault",
      label: `two-key vault ${id} on NEAR ${network} (real ${network} transactions)`,
      adapter: new VaultWallet(new GuardSigner(guardKey), { contractId: id, network }, nearSubmit(agent, id)),
      explorer: (ref) => (network === "testnet" ? `https://testnet.nearblocks.io/txns/${ref}` : `https://nearblocks.io/txns/${ref}`),
      async floor() {
        const [p, s] = await Promise.all([viewPolicy(provider, id), viewStats(provider, id)]);
        return {
          contractId: id, network, perTxNear: toNear(p.perTxCap), dailyNear: toNear(p.dailyCap), novelDailyNear: toNear(p.novelDailyCap),
          spentTodayNear: toNear(s.windowSpent), novelSpentTodayNear: toNear(s.windowNovelSpent), payees: p.payees, allowlistOnly: p.allowlistOnly, paused: p.paused,
        };
      },
    };
  } else {
    backend = { kind: "mock", label: "MOCK wallet: no real funds move (set VAULT_CONTRACT or VAULT_KEYS_FILE for the testnet vault)", adapter: new MockWallet() };
  }
  return { svc: new SiegeService({ constraints, backend, stateDir }), demoMandate };
}

export async function main() {
  const { svc, demoMandate } = await serviceFromEnv();
  if (demoMandate) console.error(`siege-mcp: MANDATE not set; using the demo mandate: "${DEMO_MANDATE}"`);
  const mcp = createSiegeMcpServer(svc);
  await mcp.connect(new StdioServerTransport());
  const c = svc.constraints;
  console.error(`siege-mcp ready (${svc.backend.label}); per tx ${fromMicro(Math.min(c.perTx.NEAR ?? Infinity, c.perTx["*"] ?? Infinity))} NEAR`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`siege-mcp: ${redact(String((e as Error).message ?? e))}`);
    process.exit(1);
  });
}
