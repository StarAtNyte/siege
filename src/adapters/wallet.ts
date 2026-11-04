// Wallet adapters. The guard is adapter-agnostic: it decides, then the adapter executes.
import type { Tx } from "../mandate/types.ts";
import { fromMicro } from "../mandate/types.ts";

export interface ExecResult {
  ok: boolean;
  ref?: string;
  error?: string;
}

export interface WalletAdapter {
  name: string;
  execute(tx: Tx): Promise<ExecResult>;
}

/** In-memory wallet: records every executed transaction. Used by the eval and the attack engine. */
export class MockWallet implements WalletAdapter {
  name = "mock";
  executed: Tx[] = [];
  constructor(private latencyMs = 0) {}
  async execute(tx: Tx): Promise<ExecResult> {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    this.executed.push(tx);
    return { ok: true, ref: `mock-${this.executed.length}` };
  }
  reset() {
    this.executed = [];
  }
}

const YOCTO = 10n ** 24n;
export function nearToYocto(near: number): string {
  const micro = BigInt(Math.round(near * 1e6));
  return ((micro * YOCTO) / 1_000_000n).toString();
}

/**
 * OutLayer agent-custody wallet on testnet (https://app.outlayer.ai/docs/agent-custody).
 * Endpoints: POST /register, POST /wallet/v1/transfer {to, amount(yocto)}, POST /wallet/v1/call
 * {receiver_id, method_name, args, deposit}, GET /wallet/v1/policy, GET /wallet/v1/audit.
 * Intents endpoints return 503 on testnet; swaps go to MockIntents instead.
 */
export class OutLayerWallet implements WalletAdapter {
  name = "outlayer-testnet";
  constructor(
    private apiKey: string,
    private base = process.env.OUTLAYER_BASE ?? "https://testnet-api.outlayer.ai",
    private intents: WalletAdapter = new MockIntents(),
  ) {}

  static async register(base = process.env.OUTLAYER_BASE ?? "https://testnet-api.outlayer.ai") {
    const r = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!r.ok) throw new Error(`register failed: ${r.status} ${await r.text()}`);
    return (await r.json()) as { api_key: string; near_account_id: string; handoff_url: string };
  }

  private async req(method: string, p: string, body?: unknown) {
    const r = await fetch(`${this.base}${p}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: r.status, json };
  }

  async execute(tx: Tx): Promise<ExecResult> {
    if (tx.kind === "swap") return this.intents.execute(tx);
    const res =
      tx.kind === "transfer"
        ? await this.req("POST", "/wallet/v1/transfer", { to: tx.recipient, amount: nearToYocto(fromMicro(tx.amount)) })
        : await this.req("POST", "/wallet/v1/call", { receiver_id: tx.recipient, method_name: tx.method, args: tx.args ?? {}, deposit: nearToYocto(fromMicro(tx.amount)) });
    if (res.status >= 400) return { ok: false, error: `${res.status} ${JSON.stringify(res.json)}` };
    return { ok: true, ref: res.json.request_id ?? res.json.tx_hash };
  }
  policy() {
    return this.req("GET", "/wallet/v1/policy");
  }
  audit() {
    return this.req("GET", "/wallet/v1/audit");
  }
}

/** NEAR Intents is mainnet-only (testnet returns 503); this mock keeps the interface honest. */
export class MockIntents implements WalletAdapter {
  name = "intents-mock";
  quotes: Record<string, number> = { "NEAR/USDC": 3.1, "USDC/NEAR": 1 / 3.1 };
  executed: Tx[] = [];
  async execute(tx: Tx): Promise<ExecResult> {
    const rate = this.quotes[`${tx.token}/${tx.toToken}`];
    if (!rate) return { ok: false, error: "no route" };
    this.executed.push(tx);
    return { ok: true, ref: `intent-mock-${this.executed.length}` };
  }
}

/**
 * Real NEAR Intents (1Click) quotes with `dry: true`: priced against live mainnet solvers, no deposit
 * address is issued and no funds move. Rejects quotes worse than `maxSlippageBps` vs the token-list price,
 * which catches a manipulated or mis-specified route before any signature exists.
 */
export class DryQuoteIntents implements WalletAdapter {
  name = "intents-dry-quote";
  assets: Record<string, { id: string; decimals: number }> = {
    NEAR: { id: "nep141:wrap.near", decimals: 24 },
    wNEAR: { id: "nep141:wrap.near", decimals: 24 },
    USDC: { id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6 },
  };
  quotes: unknown[] = [];
  constructor(private base = "https://1click.chaindefuser.com/v0", private maxSlippageBps = 300, private recipient = "siege-demo.near") {}

  async execute(tx: Tx): Promise<ExecResult> {
    const from = this.assets[tx.token], to = this.assets[tx.toToken ?? ""];
    if (!from || !to) return { ok: false, error: "unsupported asset" };
    const amount = ((BigInt(Math.round(tx.amount)) * 10n ** BigInt(from.decimals)) / 1_000_000n).toString();
    const body = {
      dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: from.id, depositType: "INTENTS",
      destinationAsset: to.id, amount, refundTo: this.recipient, refundType: "INTENTS", recipient: this.recipient,
      recipientType: "INTENTS", deadline: new Date(Date.now() + 3_600_000).toISOString(),
    };
    try {
      const r = await fetch(`${this.base}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j: any = await r.json();
      if (!r.ok || !j.quote) return { ok: false, error: `quote ${r.status}: ${JSON.stringify(j).slice(0, 200)}` };
      this.quotes.push(j);
      const inUsd = Number(j.quote.amountInUsd), outUsd = Number(j.quote.amountOutUsd);
      if (inUsd > 0 && (inUsd - outUsd) / inUsd > this.maxSlippageBps / 10_000) return { ok: false, error: `quote loses ${(100 * (inUsd - outUsd) / inUsd).toFixed(2)}%` };
      return { ok: true, ref: `dry:${j.correlationId}` };
    } catch (e) {
      return { ok: false, error: `quote unreachable: ${(e as Error).message}` };
    }
  }
}
