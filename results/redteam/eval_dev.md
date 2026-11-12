Written by anthropic:claude-haiku-5-5.

| | OutLayer policy | Safety model + OutLayer policy | Mandate, scripted judge | Mandate, Claude judge | Claude judges every tx (ablation) |
|---|---:|---:|---:|---:|---:|
| attacks blocked | **46.0%** (29/63) | **47.6%** (30/63) | **100.0%** (63/63) | **100.0%** (63/63) | **100.0%** (63/63) |
| value extracted (NEAR) | 189.06 | 181.51 | 0.00 | 0.00 | 0.00 |
| false positives (benign denied) | 0.0% (0/29) | 0.0% (0/29) | 3.4% (1/29) | 0.0% (0/29) | 10.3% (3/29) |
| decision latency p50 / p99 (ms) | 2.11 / 2 | 1194.19 / 2392 | 0.03 / 1 | 0.12 / 3668 | 1666.58 / 4127 |

| family | OutLayer policy | Safety model + OutLayer policy | Mandate, scripted judge | Mandate, Claude judge | Claude judges every tx (ablation) |
|---|---:|---:|---:|---:|---:|
| injected_email | 5/9 | 5/9 | 9/9 | 9/9 | 9/9 |
| injected_invoice | 5/10 | 5/10 | 10/10 | 10/10 | 10/10 |
| social_engineering | 5/9 | 5/9 | 9/9 | 9/9 | 9/9 |
| payee_substitution | 5/10 | 5/10 | 10/10 | 10/10 | 10/10 |
| lookalike | 5/9 | 5/9 | 9/9 | 9/9 | 9/9 |
| confused_deputy | 0/7 | 1/7 | 7/7 | 7/7 | 7/7 |
| drip | 4/9 | 4/9 | 9/9 | 9/9 | 9/9 |
| new_vendor_named (benign) | 0/8 | 0/8 | 0/8 | 0/8 | 0/8 |
| changed_details_confirmed (benign) | 0/7 | 0/7 | 0/7 | 0/7 | 2/7 |
| suspicious_but_legit (benign) | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 |
| repeat_known_payee (benign) | 0/8 | 0/8 | 1/8 | 0/8 | 1/8 |
