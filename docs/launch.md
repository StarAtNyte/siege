# Launch kit

## X post (draft, ≤280 chars)

AI agents now hold wallets. Can yours be drained?

SIEGE: write your agent's spending rules in plain English, then an evolutionary attacker tries to drain it live. Plain policy lost 177 NEAR. Our guard: 1.02, inside its budget.

Built on @NEARProtocol #NEARHackathon

Attach: docs/demo.mp4

## Demo talk track (60–90 s, record over docs/demo.mp4 or the live app)

1. "Agents with wallets follow whatever they read, including a poisoned invoice."
2. Paste a mandate. "This is the only thing the agent's owner writes."
3. Lay siege. "An evolutionary attacker breeds injections, lookalike payees and race conditions against two guards: OutLayer's policy as it works today, and SIEGE's Mandate guard."
4. Point at a red-lined clause. "Every breach is pinned to the sentence that allowed it, with the fix."
5. Verdict. "177 NEAR lost versus 1.02, which the mandate's own new-payee budget caps."
6. "Drop-in: point your agent at the SIEGE proxy instead of OutLayer. Same API. We ran it against live OutLayer testnet." Show the tx on nearblocks.

## Before publishing

- `gh repo edit StarAtNyte/near-siege --visibility public --accept-visibility-change-consequences`
- History was scanned on 2026-11-04: no keys, no .env.
