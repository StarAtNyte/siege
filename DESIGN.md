# SIEGE design

Track: AI Security & Defense. Deadline: 2026-11-14 23:59 UTC. Testnet only, no money spent.

## Problem
OutLayer already ships a TEE agent wallet (spend limits, whitelists, multisig, freeze, audit log). Its documented gaps are our target:
- Policies cannot judge intent: they "cannot restrict what the agent attaches as text or intent".
- Cumulative caps (hourly/daily/monthly) and rate limits are best-effort under concurrency, so parallel requests can overshoot.
- NEAR Intents is mainnet-only; testnet returns 503 on those endpoints.
- Free tier: 100 custody operations per wallet per day.

SIEGE sits in front of OutLayer and fills these gaps, then measures the result.

## Components
1. **Mandate (TypeScript)**
   - Mandate compiler: plain-language mandate -> structured constraints (allowed recipients, per-token caps, time windows, purpose rules).
   - Semantic check: does this transaction, its context and the agent's reasoning trace match the mandate? Catches prompt injection, address poisoning, confused deputy.
   - Two-stage pipeline: fast local classifier (few ms) handles clear cases; ambiguous cases escalate to an LLM (Claude, cheapest tier).
   - Atomic ledger: own budget counters with serialized reservation, so concurrent requests cannot overshoot cumulative caps.
   - Adapters: OutLayer testnet (transfer, call, policy, audit); Intents adapter interface with a mock implementation (real one only for mainnet, not used).
2. **Attack engine (Python 3.12 via uv, optional CUDA)**
   - Evolves transaction sequences against a policy/guard model; fitness = value extracted.
   - Output: maximum extractable loss found, plus replayable counterexamples.
   - GPU path (batched policy simulation) is a stretch goal, kept only if it beats the CPU baseline in a benchmark on day 9.
3. **Eval harness**
   - Fixed attack suite: prompt injection, address poisoning, confused deputy, drip-drain, race on cumulative caps.
   - Reports block rate, false-positive rate, added latency for plain OutLayer policy vs Mandate.
   - One command reproduces the table. Must run without an API key (local/scripted fallback).

## Honest limits (state in README)
- "Loss bound" means no counterexample found within the bounded search, not a formal proof.
- Intents settlement is mocked; settlement runs on testnet NEAR.
- The guard reduces risk; it does not make LLM judgement infallible.

## Budget
- Anthropic key in gitignored `.env`. Console cap: $40. In-code hard budget: about $25 total across both projects, counted per call, stops the run when hit.
- Local model for the bulk of calls (3-4B quantised fits the RTX 3050 6GB).

## Schedule
| Dates | Work |
|---|---|
| Nov 4-5 | Env setup (testnet account, OutLayer testnet wallet, uv, local model), ledger |
| Nov 6-8 | Guard pipeline, attack engine, eval table. SIEGE submittable; usable as a library by DARWIN |
| Nov 9-12 | (DARWIN work) |
| Nov 13 | Optional GPU kernel (only if benchmark wins), demo video, README, X post |
| Nov 14 | Make repo public, submit well before 23:59 UTC |

## Unverified assumptions (test first)
- OutLayer testnet works as documented; `/register` needs no signup.
- Faucet size and sub-account creation cost.
- The provided API key works (format is `sk-ant-usr-...`, unusual).
- Whether the submission form accepts several tracks per project.

## Submission checklist
Public repo, demo post on X tagging @NEARProtocol and #NEARHackathon with video or screenshots, description 20-2,000 characters, NEAR wallet address, scan git history for secrets before going public.
