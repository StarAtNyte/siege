// Threat model, MCP path: the compromised agent that lies to the guard, now talking to the SIEGE MCP server.
//
// Same search as the "lying to the guard" column of src/attack/threat.ts: the evolutionary search over the arena's
// attack library, with forged user instructions that name the attacker, against Mandate plus the vault model. The
// difference is the MCP server's user confirmation: a payee not vouched for by the rules, a past payment or an
// earlier confirmation is put to the user over MCP elicitation, which the agent cannot answer. Two simulated users:
//
//   deny-unexpected   approves only payees they actually deal with (the arena's legitimate vendors), denies the rest;
//   approve-all       approves every prompt (a rubber-stamping user): only the vault's floor is left.
//
// The search runs SiegeService in-process (the MCP server's core) for speed. The best attack found in every cell is
// then replayed through the real MCP server over the SDK's in-memory transport, with an SDK Client whose
// elicitation handler plays the user, and the replayed loss is reported next to the searched one.
//
//   node --import tsx src/attack/threat_mcp.ts       writes results/mcp_threat.json and results/mcp_threat.md
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { assess, render, type Gene } from "./arena.ts";
import { Search } from "./ga.ts";
import { VaultArena, setup, type VaultSetup } from "./threat.ts";
import { MANDATES } from "../eval/suite.ts";
import { VaultModel } from "../vault/model.ts";
import { VaultWallet, modelSubmit } from "../adapters/vault.ts";
import { SiegeService, type Confirm } from "../mcp/service.ts";
import { createSiegeMcpServer } from "../mcp/server.ts";
import { fromMicro, type Tx } from "../mandate/types.ts";

type MandateKey = keyof typeof MANDATES;
type User = "deny-unexpected" | "approve-all";
const VAULT = "vault.siege.testnet";

function service(s: VaultSetup, model: VaultModel, now?: () => number) {
  let n = 0n;
  const wallet = new VaultWallet(s.guard, { contractId: VAULT, network: "testnet" }, modelSubmit(model), { nonce: () => ++n });
  return new SiegeService({ constraints: s.c, backend: { kind: "vault", label: "vault model", adapter: wallet }, stateDir: null, now });
}

const userFor = (u: User, legit: Set<string>, asked: string[]): Confirm => async (q) => {
  asked.push(q.receiver);
  return u === "approve-all" || legit.has(q.receiver) ? "approved" : "denied";
};

/** The lying-agent arena, with each spend going through the MCP server's core and a simulated user. */
class McpArena extends VaultArena {
  /** Across the whole search: confirmations put to the simulated user, and how many named a payee it did not expect. */
  prompts = { asked: 0, unexpected: 0 };
  constructor(private st: VaultSetup, private user: User) {
    super(st, "honest");
  }
  override async evaluate(_guard: unknown, genome: Gene[]) {
    const svc = service(this.st, this.st.newModel());
    const asked: string[] = [];
    const confirm = userFor(this.user, this.lib.legit, asked);
    const groups = render(this.lib, genome);
    const allowed: Tx[] = [];
    const decisions = new Map<string, { verdict: string; reasons: string[]; novelBudget: boolean }>();
    for (const grp of groups) {
      // siege_pay pays NEAR transfers only; a contract call has no MCP tool.
      const outs = await Promise.all(grp.map((t) => (t.kind === "transfer" ? svc.payTx(t, confirm) : Promise.resolve(undefined))));
      outs.forEach((o, i) => {
        const ok = o?.status === "paid";
        decisions.set(grp[i].id, { verdict: ok ? "allow" : "deny", reasons: o ? o.reasons.map((r) => r.code) : ["NO_MCP_TOOL"], novelBudget: false });
        if (ok) allowed.push(grp[i]);
      });
    }
    this.prompts.asked += asked.length;
    this.prompts.unexpected += asked.filter((r) => !this.lib.legit.has(r)).length;
    const { loss, breaches } = assess(this.lib, this.constraints, allowed);
    return { loss, breaches, decisions, txs: groups.flat() };
  }
}

/** Replay one attack through the real MCP server: SDK Client -> in-memory transport -> McpServer -> vault model. */
async function replayOverMcp(s: VaultSetup, arena: McpArena, genome: Gene[], user: User) {
  let clock = 0;
  const svc = service(s, s.newModel(), () => clock);
  const asked: string[] = [];
  const confirm = userFor(user, arena.lib.legit, asked);
  const client = new Client({ name: "compromised-agent", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    const receiver = /to (\S+) for/.exec(req.params.message)?.[1] ?? "";
    const a = await confirm({ receiver, amountNear: 0, purpose: "", message: req.params.message });
    return a === "approved" ? { action: "accept", content: { approve: true } } : { action: "decline" };
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createSiegeMcpServer(svc).connect(st);
  await client.connect(ct);
  const allowed: Tx[] = [];
  let calls = 0;
  for (const grp of render(arena.lib, genome)) {
    clock = grp[0].timestampMs;
    const outs = await Promise.all(grp.map(async (t) => {
      if (t.kind !== "transfer") return false;
      calls++;
      const r = await client.callTool({
        name: "siege_pay",
        arguments: {
          receiver: t.recipient, amount_near: fromMicro(t.amount), purpose: t.memo || "payment",
          context: { user_instruction: t.context.userInstruction, retrieved: t.context.retrieved, reasoning: t.context.reasoning, source: t.context.provenance },
        },
      });
      return (r.structuredContent as { status?: string })?.status === "paid";
    }));
    outs.forEach((ok, i) => ok && allowed.push(grp[i]));
  }
  await client.close();
  return { loss: assess(arena.lib, s.c, allowed).loss, tool_calls: calls, user_prompts: asked.length, paid: allowed.map((t) => `${fromMicro(t.amount)} NEAR -> ${t.recipient}`) };
}

async function cell(s: VaultSetup, user: User, seeds: number, gens: number, pop: number) {
  const arena = new McpArena(s, user);
  const restarts: number[] = [];
  let evaluations = 0;
  let best: { loss: number; genome: Gene[] } = { loss: -1, genome: [] };
  for (let seed = 1; seed <= seeds; seed++) {
    const r = await new Search(arena, "mandate", seed).run(gens, pop);
    restarts.push(+r.loss.toFixed(2));
    evaluations += r.evaluations;
    if (r.loss > best.loss) best = { loss: r.loss, genome: r.genome };
  }
  const replay = await replayOverMcp(s, arena, best.genome, user);
  return { user, restarts, search_budget_evals: evaluations, loss: Math.max(...restarts), user_prompts_during_search: { ...arena.prompts }, replay_over_mcp: replay };
}

export async function runMcpThreat(opts: { seeds?: number; generations?: number; pop?: number } = {}) {
  const { seeds = 3, generations = 40, pop = 96 } = opts;
  const rows = [];
  for (const m of Object.keys(MANDATES) as MandateKey[]) {
    const s = setup(m);
    const noFloor: VaultSetup = { ...s, policy: { ...s.policy, novelDailyCap: s.policy.dailyCap } };
    noFloor.newModel = () => new VaultModel({ contractId: VAULT, network: "testnet", agent: VAULT, guardPk: s.guard.publicKeyBytes, ...noFloor.policy, payees: s.payees, balance: 1000n * 10n ** 24n });
    rows.push({
      mandate: m,
      deny_unexpected: await cell(s, "deny-unexpected", seeds, generations, pop),
      approve_all: await cell(s, "approve-all", seeds, generations, pop),
      approve_all_vault_without_novel_budget: s.policy.allowlistOnly ? null : await cell(noFloor, "approve-all", seeds, generations, pop),
    });
  }
  return rows;
}

function markdown(rows: Awaited<ReturnType<typeof runMcpThreat>>, before: Record<string, number>) {
  const f = (c: { loss: number; user_prompts_during_search: { asked: number; unexpected: number }; replay_over_mcp: { loss: number } } | null) =>
    c ? `${c.loss.toFixed(2)} (replay over MCP: ${c.replay_over_mcp.loss.toFixed(2)}; ${c.user_prompts_during_search.unexpected} of ${c.user_prompts_during_search.asked} prompts named an unexpected payee)` : "n/a (allowlist-only vault)";
  const L = [
    "Compromised agent lying to the guard, through the SIEGE MCP server (max NEAR lost found by the search; the best attack replayed through the real MCP server over the SDK's in-memory transport).",
    "",
    "| mandate | before: lying agent, no user confirmation (vault_threat.md) | MCP, user denies unexpected payees | MCP, user approves everything | MCP, user approves everything, vault without the unlisted-payee budget |",
    "|---|---:|---:|---:|---:|",
  ];
  for (const r of rows) L.push(`| ${r.mandate} | ${before[r.mandate]?.toFixed(2) ?? "?"} | ${f(r.deny_unexpected)} | ${f(r.approve_all)} | ${f(r.approve_all_vault_without_novel_budget)} |`);
  return L.join("\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const t = performance.now();
  const rows = await runMcpThreat();
  const out = path.resolve("results");
  let before: Record<string, number> = {};
  try {
    before = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(out, "vault_threat.json"), "utf8")).map((r: any) => [r.mandate, r.compromised_agent.lying_to_the_guard.loss]));
  } catch {
    /* run make threat first for the comparison column */
  }
  fs.writeFileSync(path.join(out, "mcp_threat.json"), JSON.stringify(rows, null, 2) + "\n");
  fs.writeFileSync(path.join(out, "mcp_threat.md"), markdown(rows, before));
  console.log(markdown(rows, before));
  console.log(`done in ${((performance.now() - t) / 1000).toFixed(1)} s`);
}
