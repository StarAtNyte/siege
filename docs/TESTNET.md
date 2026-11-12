# SIEGE vault on NEAR testnet

The two-key vault (`contract/`) deployed to testnet and exercised on 2026-11-12. Every transaction below is linked on testnet.nearblocks.io. Raw data, including each transaction's NEP-297 event: [`testnet-vault.json`](testnet-vault.json).

- **Vault:** [`vault.darwin-siege-mw23cmc8.testnet`](https://testnet.nearblocks.io/address/vault.darwin-siege-mw23cmc8.testnet)
- **Owner:** `darwin-siege-mw23cmc8.testnet` (full-access key; the only account that can change policy)
- **Code:** `contract/res/siege_vault.wasm`, 80,021 bytes. Its sha256 in base58 is `FhCBFTKPd2mA7E6vZwn78rz6Jyzx8FDRgH9XR5KSkmx2`, the same as the code hash the vault account reports.
- **Policy:** per transaction 0.05 NEAR, 0.2 NEAR per 24 clock hours, 0.02 NEAR per 24 h to payees not on the list, payee list `[owner]`, approvals live at most 1 h, network tag `testnet`.
- **Agent:** a function-call access key on the vault account, receiver = the vault, methods = `["spend"]`, gas allowance 0.25 NEAR. **Guard:** a separate ed25519 key, registered in the contract as `guard_pk`. Both keys were generated locally and stored in `.siege/vault-testnet.json`, which is gitignored and never printed.
- **Cost:** the owner account went from 4.316 to 3.319 NEAR. 1.0 NEAR was moved into the vault (about 0.82 of it is the storage stake for the code), the 0.01 NEAR test payment came back to the owner, and the rest was gas. The vault still holds 0.988 NEAR, and the owner can call `withdraw` to take it back.

Reproduce: `make contract-build && npx tsx src/vault/testnet.ts deploy && npx tsx src/vault/testnet.ts demo`.

## Setup

| step | tx |
|---|---|
| Create `vault.darwin-siege-mw23cmc8.testnet` with a fresh full-access key and fund it with 1 NEAR | [`HaGHz4UV…`](https://testnet.nearblocks.io/txns/HaGHz4UVdQCTegmskNRUzXzpAGEcNWyNYCsSPMUdC5rF) |
| One batch signed by the vault: deploy `siege_vault.wasm`, call `new(...)` (`#[private]`), and add the agent's function-call key (method `spend` only) | [`AHbGxmKF…`](https://testnet.nearblocks.io/txns/AHbGxmKFhJTU88fMaJ2c3YUFCECRuAfH1iajJLaxUEd3) |

## What each transaction shows

Arguments are Borsh (see `src/vault/borsh.ts`), so nearblocks shows them as bytes. The contract's event log on each transaction shows the receiver, amount, nonce and reason in plain JSON. A refused `spend` is a *successful* transaction that returns `{ok: false, reason}` and emits `spend_refused`: the refusal is recorded on chain, and no NEAR moves.

| # | what was attempted | result | what it shows | tx |
|---|---|---|---|---|
| 1 | Mandate (`Pay up to 0.05 NEAR per transaction to darwin-siege-mw23cmc8.testnet for invoices. Never spend more than 0.2 NEAR per day.`) allows a 0.01 NEAR invoice payment the user asked for. The guard signs it and the agent's function-call key calls `spend` | **paid**, event `spend` | A guard-approved spend pays out through the agent's restricted key | [`Gmvqcm4x…`](https://testnet.nearblocks.io/txns/Gmvqcm4xn8Hz34Y2KBibz9RmMRQE9BKVBaQfu37cZhHA) |
| 2 | An injected email asks for 0.04 NEAR to `drainer.testnet` | Mandate denies it (`RECIPIENT_NOT_ALLOWED`); 0 signatures issued | A denied spend never gets a signature, so the agent has nothing it could submit | none (it never reaches the chain) |
| 3 | The agent's key calls `spend` to `drainer.testnet` with no guard signature | **refused `BAD_SIGNATURE`** | Holding the function-call key is not enough to pay | [`6FKZ3cbs…`](https://testnet.nearblocks.io/txns/6FKZ3cbstrmCgpjPvNLgYoLpRYPHjZVXePWthYSTGwD3) |
| 4 | The agent signs an approval with a key of its own | **refused `BAD_SIGNATURE`** | Only the registered guard key counts | [`Fj2LideS…`](https://testnet.nearblocks.io/txns/Fj2LideSowvPxKbjbEHqe3cotBJSeyih6tqz8evUynHL) |
| 5 | The agent resubmits the guard's genuine approval from #1 | **refused `NONCE_REUSED`** (`nonce_used` view: true) | Each approval pays once | [`3H5Kj8z1…`](https://testnet.nearblocks.io/txns/3H5Kj8z1xYXMfxyWG9ST4UQ5xMAP4ByWitc9DpusbDUm) |
| 6 | The **guard key** signs 0.1 NEAR to the owner, twice the per-transaction cap (a compromised guard) | **refused `PER_TX_CAP`** | The caps hold even with a valid signature | [`ruuESjHa…`](https://testnet.nearblocks.io/txns/ruuESjHafiHpNhzwBLhioYSF1wCDQURazp5zZYAgYHX) |
| 7 | The **guard key** signs 0.03 NEAR to `drainer.testnet`, which is not on the payee list (budget 0.02 NEAR per 24 h) | **refused `NOVEL_PAYEE_BUDGET`** | A compromised guard can send unlisted accounts at most the unlisted-payee budget | [`EvKB92s3…`](https://testnet.nearblocks.io/txns/EvKB92s3zFaWjfzBYUr7qS6FnvKyzYr5iyGwbgmiKU4r) |
| 8a | The agent's key calls the owner method `set_policy` with the 1 yoctoNEAR it requires | Rejected by the network: `Deposit is not allowed with function call` | Function-call keys cannot attach a deposit, so no owner method (each needs 1 yocto) can be called with the agent's key | none: the transaction is rejected before it is included |
| 8b | The agent's key calls `pause` | Rejected by the network: `Access key does not allow method pause` | The key's method list is `["spend"]` | none: the transaction is rejected before it is included |
| 9 | The owner (full-access key, 1 yocto) calls `pause` | paused | Owner kill switch | [`9MkaLQ83…`](https://testnet.nearblocks.io/txns/9MkaLQ83zHwNJgfipWsZtXSkGXrWPcn4Me4j4ZwUzWvS) |
| 10 | A genuine guard-signed 0.01 NEAR spend to a listed payee while paused | **refused `PAUSED`** | Pause overrides any signature | [`5TBYeXnk…`](https://testnet.nearblocks.io/txns/5TBYeXnkn35772r8nmn8EMEhz1RiTMSGMVEaTWL8A1zu) |
| 11 | The owner calls `unpause` | unpaused | | [`6EPjL7tE…`](https://testnet.nearblocks.io/txns/6EPjL7tEC2abjKfURarmBVHSmDmwwLRHqbNK48qnQz4K) |

After the run the vault's `get_stats` reports `total_spent` = 0.01 NEAR, 1 spend and 6 refusals: rows 3 to 7, 10 and the paid spend in row 1 are all that reached `spend`.

Rows 8a and 8b have no hash because the NEAR runtime validates the access key before a transaction is included, and drops it if the key does not permit the call. The errors above are the RPC's own messages. That this happens is documented NEAR protocol behaviour: function-call keys "do not allow to attach NEAR tokens to the call" and are limited to their receiver and method list ([NEAR docs: access keys](https://docs.near.org/protocol/access-keys)).
