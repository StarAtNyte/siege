"""siege-attack: run the evolutionary attack against plain OutLayer policy and against Mandate."""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from .evolve import evolve
from .oracle import Oracle, SIEGE_ROOT


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--generations", type=int, default=40)
    ap.add_argument("--pop", type=int, default=96)
    ap.add_argument("--seeds", type=int, default=3, help="independent restarts per target")
    ap.add_argument("--guards", default="outlayer,mandate")
    ap.add_argument("--mandates", default="whitelist,open")
    args = ap.parse_args()

    out_dir = SIEGE_ROOT / "results"
    out_dir.mkdir(exist_ok=True)
    oracle = Oracle()
    t0 = time.time()
    summary = []
    for guard in args.guards.split(","):
        for mandate in args.mandates.split(","):
            runs = [evolve(oracle, guard, mandate, args.generations, args.pop, seed=s) for s in range(args.seeds)]
            best = max(runs, key=lambda x: x["loss"])
            evals = args.generations * args.pop * args.seeds
            rec = {"guard": guard, "mandate": mandate, "best": best, "restarts": [x["loss"] for x in runs], "search_budget_evals": evals}
            path = out_dir / f"attack_{guard}_{mandate}.json"
            path.write_text(json.dumps(rec, indent=2))
            summary.append(rec)
    oracle.close()

    print(f"\nMaximum extractable loss found (bounded search; {oracle.calls} guard evaluations, {time.time() - t0:.0f}s)\n")
    print("| guard | mandate | max loss found (NEAR) | restarts | counterexample |")
    print("|---|---|---:|---|---|")
    for s in summary:
        cx = f"results/attack_{s['guard']}_{s['mandate']}.json" if s["best"]["loss"] > 0 else "none found"
        print(f"| {s['guard']} | {s['mandate']} | {s['best']['loss']:.2f} | {', '.join(f'{x:.1f}' for x in s['restarts'])} | {cx} |")
    print("\n'none found' means no counterexample within this search budget. It is not a proof.")
    print("Replay one: npx tsx src/replay.ts results/attack_outlayer_open.json")
    (out_dir / "attack_summary.json").write_text(json.dumps([{k: v for k, v in s.items() if k != "best"} | {"loss": s["best"]["loss"]} for s in summary], indent=2))


if __name__ == "__main__":
    main()
