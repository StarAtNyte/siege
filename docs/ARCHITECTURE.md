# SIEGE architecture

## Two layers

A policy check that runs only inside the agent's process stops working once that process is compromised. Moving the check into a separate proxy helps only if the agent cannot go around the proxy. SIEGE therefore uses two layers. The chain enforces the first. The second judges intent, and the chain *requires* its approval.

```
 agent ──(proxy token + context)──▶ SIEGE proxy / Mandate guard ──(guard-signed approval)──▶ vault contract ──▶ payee
   │                                     holds the guard key                                    checks signature,
   └── holds only a function-call key on the vault, method: spend ─────────────────────────────▶ nonce, expiry, caps
```

**Layer 1: the floor (`contract/`, the vault).** The vault contract holds the NEAR. The agent's function-call access key can call exactly one method, `spend`. The contract enforces hard limits no matter who signed:

- a per-transaction cap;
- a cap per 24 clock hours;
- a smaller budget, per 24 h, for payees that are not on the owner's payee list;
- an optional allowlist-only mode;
- a pause switch.

Only the owner, from a full-access key with 1 yoctoNEAR attached, can change these. This is the same floor that allowlist-and-cap vaults provide. It does not depend on any off-chain code being honest.

**Layer 2: intent (Mandate).** Caps and allowlists cannot tell a real invoice from an injected one when the mandate is open ("pay any vendor invoice"). Mandate reads what the user asked for and what the agent read, and decides whether this payment is what the user meant (see the README). In the vault setup, Mandate's decision gates the money. The guard holds its own ed25519 key, separate from the agent's. It signs an approval only after Mandate allows the spend, and `spend` refuses anything without a valid approval:

```
message   = "siege-vault-v1|<network>|<vault account>|<receiver>|<amount yoctoNEAR>|<nonce u64>|<expires_at ns>"
guard_sig = ed25519_sign(guard secret key, utf8(message))          // verified on chain with env::ed25519_verify
```

The network tag and the vault account id stop an approval from being reused on another vault or network. The nonce is single use. `expires_at` must be in the future and at most 1 h away (an owner setting). Account ids cannot contain `|` and every other field is a decimal integer, so the encoding is unambiguous. A Rust golden vector (`contract/src/tests.rs`) and the TypeScript signer (`src/vault/approval.ts`, `test/vault.test.ts`) assert the same bytes and the same signature.

`spend` checks, in this order:

1. paused;
2. caller is the agent;
3. amount > 0;
4. **guard signature**;
5. expiry and max TTL;
6. nonce unused. From this step on, the nonce is consumed even if a later check refuses the spend.
7. receiver is not the vault;
8. allowlist;
9. per-transaction cap;
10. 24-hour cap;
11. unlisted-payee budget;
12. balance above the storage reserve.

A refusal does not panic. `spend` returns `{ok: false, reason}` and emits a NEP-297 event (`standard: "siege_vault"`, `event: "spend_refused"`, `reason`), so refusals are recorded on chain. A paid spend emits `spend`. NEAR runs each contract's receipts one at a time, so concurrent `spend` calls cannot jointly overshoot a cap.

| contract method | who | notes |
|---|---|---|
| `new(owner, agent, guard_pk, network, per_tx_cap, daily_cap, novel_daily_cap, payees, allowlist_only)` | the vault account (`#[private]`) | once, at deploy |
| `spend(receiver, amount, nonce, expires_at, guard_sig)` | the agent | the only method the agent's key may call |
| `set_policy`, `set_payees`, `set_guard`, `set_agent`, `pause`, `unpause`, `withdraw` | owner, 1 yocto | a function-call key cannot attach a deposit, so these need a full-access key |
| `get_policy`, `get_stats`, `nonce_used`, `approval_message` | anyone (view) | `approval_message` returns the exact text to sign |

Arguments and results are Borsh, which keeps serde_json out of the wasm (80 KB after `wasm-opt`, about 0.8 NEAR of storage stake). `src/vault/borsh.ts` encodes them.

**How the agent reaches the vault.** `npm run proxy` with `VAULT_CONTRACT` set runs the guard in front of the vault:

- `POST /wallet/v1/transfer` (same body as OutLayer): Mandate decides, the guard signs, and the proxy relays `spend` with the agent's function-call key.
- `POST /siege/v1/approve`: returns the signed approval, so an agent that holds its own function-call key can submit `spend` itself.

In both modes a denied spend is never signed. In OutLayer mode the proxy holds the OutLayer API key and the agent gets only a proxy-issued token. A request that carries an OutLayer key is refused (`outlayer_key_rejected`), so a compromised agent has no key it could use against OutLayer directly.

### If the agent is compromised, and if the guard is compromised

Measured with `make threat` (`src/attack/threat.ts`, results in `results/vault_threat.json` / `.md`). The search part is the evolutionary search from `make attack` (96 genomes × 40 generations × 3 restarts per cell), run against Mandate plus the vault. The vault is the TypeScript model in `src/vault/model.ts`. The Rust contract is tested against 240 shared differential vectors (`contract/vectors/differential.json`) and gives the same outcome on every one.

| mandate | vault floor (per tx / 24 h / unlisted payees per 24 h) | compromised agent: goes around the guard | compromised agent: lies to the guard | compromised guard (signs anything): search | compromised guard: greedy, 7 days |
|---|---|---:|---:|---:|---:|
| whitelist | 5 / 20 / allowlist only | **0.00 NEAR** (96 attempts) | 0.00 | 0.00 | 0.00 |
| open ("pay any vendor invoice") | 10 / 30 / 3 | **0.00 NEAR** (96 attempts) | 3.00 | 3.00 | 21.00 (3.00 per day) |

- **Compromised agent, going around the guard.** The agent has the function-call key. It tried 96 times per mandate:
  - no signature, its own signature, random bytes;
  - genuine approvals replayed, sent to a different payee, raised in amount, or extended in expiry;
  - genuine guard signatures for another vault or for mainnet;
  - approvals it held back until they expired.

  Every attempt was refused, and nothing was paid outside the honest traffic. On testnet the same attacks are transactions 3, 4 and 5 in [TESTNET.md](TESTNET.md). The owner methods are out of reach because the protocol rejects any call from the agent's key except `spend`.
- **Compromised agent, lying to the guard.** The guard sees only the context the agent sends. An agent that forges the user's instruction to name the attacker ("Pay x7f3a.testnet for the invoice") passes Mandate's intent check under an open mandate. Under the whitelist mandate it gets nothing. Under the open mandate the on-chain budget for unlisted payees holds it to 3.00 NEAR per 24 h. With that budget removed (ablation, same search) the agent took 30.00, the full daily cap. Closing this gap completely needs the user's instruction to reach the guard over a channel the agent cannot write to, for example signed by the user. SIEGE does not do that yet.
- **Compromised guard.** If the guard key signs whatever the attacker asks, only the contract's caps are left. Under the whitelist mandate the vault is allowlist-only, so an attacker account cannot be paid at all. A compromised guard can still pay the listed payees up to the caps, which wastes money but does not reach the attacker. Under the open mandate the attacker can take at most the unlisted-payee budget per 24 clock hours: the search found 3.00 NEAR, and the greedy attacker that tries every hour for 7 days took 21.00 NEAR (3.00 per day). The owner can `pause`, or rotate the key with `set_guard`; rotating invalidates every approval signed with the old key (`rotated_guard_key_invalidates_old_signatures`). On testnet, transactions 6 and 7 are a valid guard signature refused for exceeding the per-transaction cap and the unlisted-payee budget.

The window is 24 clock-hour buckets, so the bound is "at most the cap in any 24 consecutive clock hours". Two windows that touch can together allow up to twice the cap within slightly more than 24 hours.

### How this relates to NEAR's existing agent permissioning

- **OutLayer agent custody** ([docs](https://app.outlayer.ai/docs/agent-custody)) keeps the agent's keys in Intel TDX enclaves ("The agent never sees or stores a private key"). Its policies cover:
  - per-transaction caps, plus hourly, daily and monthly totals;
  - whitelists and blacklists;
  - time windows and a transaction rate limit;
  - per-operation capabilities;
  - multisig approval and an emergency freeze.

  Its docs say the cumulative caps are best-effort under concurrent requests, and that judging an operation is left to the approvers. SIEGE already ships an OutLayer adapter (`OutLayerWallet`) and the guard proxy for it, and `toOutlayerPolicy()` exports the same mandate as an OutLayer policy. In that path SIEGE layers on top of OutLayer's custody rather than replacing it. The proxy now holds the OutLayer API key, so the agent cannot skip the proxy. The OutLayer TEE path remains an alternative to the vault.
- **NEAR function-call access keys** ([docs](https://docs.near.org/protocol/access-keys)) are limited to one receiver contract and an optional method list. They "do not allow to attach NEAR tokens to the call" and prohibit NEAR transfers. The vault relies on exactly this: the agent's key names the vault and `spend`, and the owner methods require 1 yoctoNEAR, which such a key cannot attach. Testnet transactions 8a and 8b show both rejections.
- **NEP-413 message signing** ([NEP-413](https://github.com/near/NEPs/blob/master/neps/nep-0413.md)) "Must be signed using a Full Access Key"; function-call keys are excluded because "Any third-party can ask the user to create a `FunctionCall Key`". An agent that may sign NEP-413 messages, as NEAR Intents uses, therefore needs a full-access key, which a function-call-key restriction cannot limit. For intents, the bounds have to come from somewhere else. One option is custody in which the agent never holds the key (OutLayer's TEE policies). The other is a contract that holds the funds and pays out only against a guard signature under on-chain caps, as the vault does for NEAR transfers. The vault does not handle intents yet (see the limits below).

### Limits of this layer

- The vault pays NEAR transfers only. Function calls (for example staking) and NEAR Intents are not covered; the vault adapter refuses them. Those keep using the OutLayer path, or are refused.
- The guard is only as good as the context it receives (see "lying to the guard" above). The vault bounds that case. It does not prevent it.
- In relay mode the proxy holds both the guard key and the agent's function-call key, so a compromise of the proxy is a compromise of the guard, and the loss is bounded by the caps above. Keeping the guard key in a separate process or enclave from the agent's key is the stronger deployment (`/siege/v1/approve`).
- A refused `spend` that already passed the signature and nonce checks consumes the nonce. That is deliberate (approvals are single use), so a refused approval cannot be retried; the agent asks the guard again.
- The arena's numbers come from a model of the contract, pinned to it by the differential vectors and the property test (`property_conservation_and_caps`: conservation of NEAR leaving the vault, signature, nonce, expiry and every cap across random interleavings). They are not a formal proof.
