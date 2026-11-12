// VaultWallet: the guard side of the two-key vault (contract/src/lib.rs).
//
// The Mandate guard calls execute() only after it allows a spend, so only allowed spends are ever signed: the
// guard's ed25519 key (separate from the agent's function-call key) signs the approval, and a submitter puts
// spend(receiver, amount, nonce, expires_at, guard_sig) on chain, either relayed by the proxy with the agent's
// function-call key (src/vault/near.ts) or handed back to the agent to submit itself. The contract then checks the
// signature, the nonce, the expiry and its own hard caps. A denied spend never gets a signature.
import crypto from "node:crypto";
import type { Tx } from "../mandate/types.ts";
import type { ExecResult, WalletAdapter } from "./wallet.ts";
import { GuardSigner, type SignedApproval } from "../vault/approval.ts";
import { VaultModel, YOCTO_PER_MICRO } from "../vault/model.ts";

export interface VaultTarget {
  contractId: string;
  network: string;
}

export type Submit = (a: SignedApproval, tx: Tx) => Promise<ExecResult>;

export interface VaultWalletOptions {
  /** Approval lifetime; the contract refuses anything over its max TTL (1 h by default). */
  ttlMs?: number;
  nonce?: () => bigint;
}

const randomNonce = () => crypto.randomBytes(8).readBigUInt64BE() >> 1n;

export class VaultWallet implements WalletAdapter {
  name = "siege-vault";
  /** Every approval this guard has signed, for audit. */
  readonly signed: SignedApproval[] = [];

  constructor(
    private signer: GuardSigner,
    readonly target: VaultTarget,
    private submit: Submit,
    private opts: VaultWalletOptions = {},
  ) {}

  /** Sign an approval for a spend the guard has already allowed. */
  approve(tx: Tx): SignedApproval {
    if (tx.kind !== "transfer" || tx.token !== "NEAR") throw new Error("the vault pays NEAR transfers only");
    const a = this.signer.approve(this.target.network, this.target.contractId, {
      receiver: tx.recipient.toLowerCase(),
      amount: (BigInt(Math.round(tx.amount)) * YOCTO_PER_MICRO).toString(),
      nonce: (this.opts.nonce ?? randomNonce)().toString(),
      expires_at: (BigInt(tx.timestampMs + (this.opts.ttlMs ?? 10 * 60_000)) * 1_000_000n).toString(),
    });
    this.signed.push(a);
    return a;
  }

  async execute(tx: Tx): Promise<ExecResult> {
    let a: SignedApproval;
    try {
      a = this.approve(tx);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    return this.submit(a, tx);
  }
}

/** Submit to an in-memory VaultModel as `caller` (the arena and tests). */
export function modelSubmit(model: VaultModel, caller = model.cfg.agent): Submit {
  return async (a, tx) => {
    const r = model.spend({ caller, receiver: a.receiver, amount: BigInt(a.amount), nonce: BigInt(a.nonce), expiresAt: BigInt(a.expires_at), sig: a.guard_sig, nowNs: BigInt(tx.timestampMs) * 1_000_000n });
    return r.ok ? { ok: true, ref: `vault:${a.nonce}` } : { ok: false, error: `vault refused: ${r.reason}` };
  };
}
