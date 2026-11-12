// On-chain side of the vault: submit spend() with the agent's function-call key, and read the vault's views.
import { actions, type Account, type JsonRpcProvider } from "near-api-js";
import type { ExecResult } from "../adapters/wallet.ts";
import type { Submit } from "../adapters/vault.ts";
import type { SignedApproval } from "./approval.ts";
import { decodePolicy, decodeSpendOutcome, decodeStats, encodeSpend, W } from "./borsh.ts";

export const SPEND_GAS = 30_000_000_000_000n;
export const txHash = (r: any): string => r?.transaction_outcome?.id ?? r?.transaction?.hash;

/** Raw spend() call. Returns the tx hash and the decoded SpendOutcome (or the protocol error). */
export async function callSpend(agent: Account, vaultId: string, a: SignedApproval) {
  const r: any = await agent.signAndSendTransaction({ receiverId: vaultId, actions: [actions.functionCall("spend", encodeSpend(a), SPEND_GAS, 0n)], throwOnFailure: false });
  const ok = r?.status?.SuccessValue;
  const outcome = typeof ok === "string" ? decodeSpendOutcome(Buffer.from(ok, "base64")) : { ok: false, reason: `TX_FAILED ${JSON.stringify(r?.status?.Failure ?? r?.status).slice(0, 200)}` };
  const logs: string[] = (r?.receipts_outcome ?? []).flatMap((o: any) => o.outcome.logs);
  return { hash: txHash(r), outcome, logs };
}

/** Submitter for VaultWallet that relays spend() with the agent's function-call key. */
export function nearSubmit(agent: Account, vaultId: string): Submit {
  return async (a: SignedApproval): Promise<ExecResult> => {
    try {
      const { hash, outcome } = await callSpend(agent, vaultId, a);
      return outcome.ok ? { ok: true, ref: hash } : { ok: false, error: `vault refused: ${outcome.reason} (${hash})` };
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e).slice(0, 200) };
    }
  };
}

async function view(p: JsonRpcProvider, vaultId: string, method: string, args: Uint8Array = new Uint8Array()) {
  const r: any = await p.callFunctionRaw({ contractId: vaultId, method, args });
  return Uint8Array.from(r.result as number[]);
}
export const viewPolicy = async (p: JsonRpcProvider, id: string) => decodePolicy(await view(p, id, "get_policy"));
export const viewStats = async (p: JsonRpcProvider, id: string) => decodeStats(await view(p, id, "get_stats"));
export const viewNonceUsed = async (p: JsonRpcProvider, id: string, n: bigint) => (await view(p, id, "nonce_used", new W().u64(n).done()))[0] === 1;
