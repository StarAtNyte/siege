// Guard approvals for the SIEGE vault contract (contract/src/lib.rs).
//
// The guard holds its own ed25519 key, separate from the agent. When Mandate allows a spend, the guard signs
//   siege-vault-v1|<network>|<vault contract id>|<receiver>|<amount yocto>|<nonce>|<expires_at ns>
// and the vault's spend() verifies that signature with env::ed25519_verify against the registered guard key.
// Account ids cannot contain "|", and every other field is decimal digits, so the encoding is unambiguous.
// Binding the network and contract id stops a signature for one vault being replayed on another.
import crypto from "node:crypto";

export const MESSAGE_TAG = "siege-vault-v1";

export interface Approval {
  receiver: string;
  /** yoctoNEAR, decimal string. */
  amount: string;
  /** u64, decimal string; single use per vault. */
  nonce: string;
  /** Block timestamp (ns since epoch), decimal string; the approval is invalid at or after it. */
  expires_at: string;
}

export interface SignedApproval extends Approval {
  /** base64 of the 64-byte ed25519 signature. */
  guard_sig: string;
}

export function approvalMessage(network: string, contractId: string, a: Approval): string {
  for (const [k, v] of Object.entries({ amount: a.amount, nonce: a.nonce, expires_at: a.expires_at })) {
    if (!/^(0|[1-9][0-9]*)$/.test(v)) throw new Error(`${k} must be a decimal integer string`);
  }
  if (!/^[a-z0-9._-]{2,64}$/.test(a.receiver) || !/^[a-z0-9._-]{2,64}$/.test(contractId)) throw new Error("bad account id");
  if (!/^[a-z0-9-]{1,32}$/.test(network)) throw new Error("bad network tag");
  return [MESSAGE_TAG, network, contractId, a.receiver, a.amount, a.nonce, a.expires_at].join("|");
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes: Uint8Array): string {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
export function unbase58(s: string): Buffer {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let zeros = 0;
  while (s[zeros] === "1") zeros++;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/** The guard's signing key. Accepts a NEAR-format secret ("ed25519:<base58 of seed||pub>") or a 32-byte seed. */
export class GuardSigner {
  private key: crypto.KeyObject;
  readonly publicKeyBytes: Buffer;

  constructor(secret: string | Uint8Array) {
    let seed: Buffer;
    if (typeof secret === "string") {
      const raw = unbase58(secret.replace(/^ed25519:/, ""));
      if (raw.length !== 64 && raw.length !== 32) throw new Error("guard key must be an ed25519 secret");
      seed = raw.subarray(0, 32);
    } else seed = Buffer.from(secret);
    if (seed.length !== 32) throw new Error("guard seed must be 32 bytes");
    this.key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
    this.publicKeyBytes = Buffer.from(crypto.createPublicKey(this.key).export({ format: "der", type: "spki" })).subarray(-32);
  }

  static generate(): { signer: GuardSigner; secret: string } {
    const seed = crypto.randomBytes(32);
    const s = new GuardSigner(seed);
    return { signer: s, secret: `ed25519:${base58(Buffer.concat([seed, s.publicKeyBytes]))}` };
  }

  /** NEAR-format public key, as the vault's set_guard / new expect. */
  get publicKey(): string {
    return `ed25519:${base58(this.publicKeyBytes)}`;
  }

  sign(message: string): string {
    return crypto.sign(null, Buffer.from(message, "utf8"), this.key).toString("base64");
  }

  approve(network: string, contractId: string, a: Approval): SignedApproval {
    return { ...a, guard_sig: this.sign(approvalMessage(network, contractId, a)) };
  }
}

export function verifyApproval(network: string, contractId: string, publicKeyBytes: Uint8Array, a: SignedApproval): boolean {
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyBytes)]), format: "der", type: "spki" });
  try {
    const sig = Buffer.from(a.guard_sig, "base64");
    return sig.length === 64 && crypto.verify(null, Buffer.from(approvalMessage(network, contractId, a), "utf8"), pub, sig);
  } catch {
    return false;
  }
}
