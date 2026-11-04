# SIEGE: can your AI wallet be drained?

Track: AI Security & Defense. Testnet only; NEAR Intents is mocked behind an adapter (mainnet-only, no funds spent).

## Parts
1. **Mandate** (TypeScript): plain-language mandate -> compiled constraints + semantic check in front of an OutLayer wallet. Atomic ledger so cumulative caps cannot be overshot by concurrent requests.
2. **Attack engine** (Python, optional CUDA): evolves transaction sequences against a policy/guard and reports the maximum extractable loss plus replayable counterexamples.
3. **Eval harness**: fixed attack suite (prompt injection, address poisoning, confused deputy, drip-drain, race on cumulative caps). Reports block rate, false positives, latency for plain OutLayer policy vs Mandate.

## Honest limits (state in README)
- Loss bound means "no counterexample found within the bounded search", not a formal proof.
- Intents settlement is mocked; settlement runs on testnet NEAR.

## Done when
- One command reproduces the eval table.
- Demo: engine finds a drain on plain policy, finds none on Mandate.
