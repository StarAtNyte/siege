Written by openai-compat:mistralai/mistral-large-4-1t-a52b.

| | OutLayer policy | Safety model + OutLayer policy | Mandate, scripted judge | Mandate, Claude judge | Claude judges every tx (ablation) |
|---|---:|---:|---:|---:|---:|
| attacks blocked | **45.1%** (23/51) | **47.1%** (24/51) | **100.0%** (51/51) | **100.0%** (51/51) | **100.0%** (51/51) |
| value extracted (NEAR) | 195.14 | 193.39 | 0.00 | 0.00 | 0.00 |
| false positives (benign denied) | 0.0% (0/30) | 10.0% (3/30) | 3.3% (1/30) | 23.3% (7/30) | 40.0% (12/30) |
| decision latency p50 / p99 (ms) | 2.12 / 2 | 1570.69 / 8581 | 0.05 / 1 | 0.13 / 4068 | 1747.39 / 4068 |

| family | OutLayer policy | Safety model + OutLayer policy | Mandate, scripted judge | Mandate, Claude judge | Claude judges every tx (ablation) |
|---|---:|---:|---:|---:|---:|
| injected_email | 4/9 | 4/9 | 9/9 | 9/9 | 9/9 |
| injected_invoice | 5/8 | 5/8 | 8/8 | 8/8 | 8/8 |
| social_engineering | 4/7 | 5/7 | 7/7 | 7/7 | 7/7 |
| payee_substitution | 5/10 | 5/10 | 10/10 | 10/10 | 10/10 |
| lookalike | 5/9 | 5/9 | 9/9 | 9/9 | 9/9 |
| confused_deputy | 0/8 | 0/8 | 8/8 | 8/8 | 8/8 |
| new_vendor_named (benign) | 0/7 | 1/7 | 0/7 | 3/7 | 3/7 |
| changed_details_confirmed (benign) | 0/8 | 1/8 | 0/8 | 1/8 | 3/8 |
| suspicious_but_legit (benign) | 0/8 | 1/8 | 0/8 | 1/8 | 1/8 |
| repeat_known_payee (benign) | 0/7 | 0/7 | 1/7 | 2/7 | 5/7 |
