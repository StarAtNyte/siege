"""Talks JSONL to the TypeScript oracle, which runs the real guard code."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

SIEGE_ROOT = Path(__file__).resolve().parents[2]


class Oracle:
    def __init__(self) -> None:
        tsx = SIEGE_ROOT / "node_modules" / ".bin" / "tsx"
        self.proc = subprocess.Popen(
            [str(tsx), str(SIEGE_ROOT / "src" / "oracle.ts")],
            cwd=SIEGE_ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            bufsize=1,
            env={**os.environ, "SIEGE_LLM": os.environ.get("SIEGE_LLM", "0")},
        )
        self._id = 0
        self.calls = 0

    def batch(self, guard: str, mandate: str, genomes: list[list[dict]], full: bool = False) -> list[dict]:
        assert self.proc.stdin and self.proc.stdout
        ids = []
        for g in genomes:
            self._id += 1
            ids.append(self._id)
            self.proc.stdin.write(json.dumps({"id": self._id, "guard": guard, "mandate": mandate, "genome": g, "full": full}) + "\n")
        self.proc.stdin.flush()
        out = {}
        while len(out) < len(ids):
            r = json.loads(self.proc.stdout.readline())
            out[r["id"]] = r
        self.calls += len(ids)
        return [out[i] for i in ids]

    def close(self) -> None:
        if self.proc.stdin:
            self.proc.stdin.close()
        self.proc.wait(timeout=10)
