// Core data model shared by the guard, the baseline policy, the eval harness and the attack engine.

/** Amounts are integer micro-units (1e-6 of a token) so ledger math never touches floats. */
export type Micro = number;
export const MICRO = 1_000_000;
export const toMicro = (x: number): Micro => Math.round(x * MICRO);
export const fromMicro = (m: Micro): number => m / MICRO;

export type TxKind = "transfer" | "call" | "swap";

/** Where the instruction that caused this transaction came from. */
export type Provenance = "user" | "retrieved" | "tool_output" | "agent";

export interface TxContext {
  /** What the human principal actually asked for in this session. */
  userInstruction: string;
  /** Untrusted text the agent read (web pages, emails, invoices, tool outputs). */
  retrieved: string[];
  /** The agent's stated reasoning for this transaction. */
  reasoning: string;
  /** Which source the agent says triggered the action. */
  provenance: Provenance;
}

export interface Tx {
  id: string;
  agentId: string;
  kind: TxKind;
  token: string; // "NEAR", "USDC", ...
  amount: Micro;
  recipient: string; // NEAR account id
  method?: string; // for kind=call
  /** Call arguments (kind=call). Any account ids inside are checked for grounding. */
  args?: Record<string, unknown>;
  memo: string;
  /** For swaps: token received. */
  toToken?: string;
  timestampMs: number;
  context: TxContext;
}

export type Verdict = "allow" | "deny";

export interface Decision {
  verdict: Verdict;
  /** Machine-readable reason codes, e.g. RECIPIENT_NOT_ALLOWED, INJECTION_SUSPECTED. */
  reasons: string[];
  /** Which stage made the call. */
  stage: "constraints" | "classifier" | "llm" | "ledger" | "policy" | "adapter";
  latencyMs: number;
  /** Classifier risk score 0..1 when computed. */
  risk?: number;
}

export interface WindowCap {
  windowMs: number;
  cap: Micro;
}

/** Structured constraints compiled from a plain-language mandate. */
export interface Constraints {
  /** Exact-match recipients. Empty + openRecipients=false means nobody. */
  allowedRecipients: string[];
  /** Mandates like "pay any vendor invoice" cannot be whitelisted; semantic check carries the load. */
  openRecipients: boolean;
  /** Recipient suffix patterns, e.g. ".vendors.testnet". */
  allowedRecipientSuffixes: string[];
  /** Explicitly forbidden recipients. */
  deniedRecipients: string[];
  perTx: Record<string, Micro>; // token -> cap; "*" = any
  windows: Record<string, WindowCap[]>; // token -> caps; "*" = summed across tokens
  /** UTC hours [start, end) when spending is allowed. */
  activeHoursUtc?: [number, number];
  allowedKinds: TxKind[];
  allowedMethods: string[]; // for kind=call; empty = none
  allowedSwapPairs: [string, string][];
  /** Free-text purposes the mandate permits, e.g. "invoices", "hosting". */
  purposes: string[];
  /** The original text, kept for the semantic stage. */
  source: string;
}

export interface MandateGuardLike {
  name: string;
  /** Decide and (if allowed) execute. Must be safe to call concurrently. */
  submit(tx: Tx): Promise<Decision>;
  /** Reset all counters (for repeatable experiments). */
  reset(): void;
}
