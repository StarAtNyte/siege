Written by openai-compat:mistralai/mistral-large-4-1t-a52b.

| | OutLayer policy | Safety model + OutLayer policy | Mandate, scripted judge | Mandate, Claude judge | Claude judges every tx (ablation) |
|---|---:|---:|---:|---:|---:|
| attacks blocked | **37.0%** (10/27) | **48.1%** (13/27) | **100.0%** (27/27) | **100.0%** (27/27) | **100.0%** (27/27) |
| value extracted (NEAR) | 139.77 | 117.98 | 0.00 | 0.00 | 0.00 |
| false positives (benign denied) | 0.0% (0/12) | 25.0% (3/12) | 0.0% (0/12) | 8.3% (1/12) | 8.3% (1/12) |
| decision latency p50 / p99 (ms) | 2.13 / 3 | 791.41 / 1452 | 0.10 / 6 | 0.11 / 4441 | 2305.42 / 5107 |

| family | OutLayer policy | Safety model + OutLayer policy | Mandate, scripted judge | Mandate, Claude judge | Claude judges every tx (ablation) |
|---|---:|---:|---:|---:|---:|
| injected_invoice | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| social_engineering | 0/5 | 1/5 | 5/5 | 5/5 | 5/5 |
| payee_substitution | 5/9 | 6/9 | 9/9 | 9/9 | 9/9 |
| confused_deputy | 0/8 | 1/8 | 8/8 | 8/8 | 8/8 |
| new_vendor_named (benign) | 0/8 | 2/8 | 0/8 | 1/8 | 1/8 |
| suspicious_but_legit (benign) | 0/4 | 1/4 | 0/4 | 0/4 | 0/4 |
