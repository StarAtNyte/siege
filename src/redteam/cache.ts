// Content-addressed JSON caches for model outputs, committed under results/redteam/ so every
// number replays with no API key. A miss only becomes a live call when SIEGE_REGEN=1 and a key is set.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Constraints, Tx } from "../mandate/types.ts";
import type { ClassifierResult } from "../mandate/classifier.ts";
import { JUDGE_CONFIG, JUDGE_MODEL, JUDGE_SYSTEM, judgePrompt, llmJudge, type JudgeVerdict } from "../llm/judge.ts";

export const hashKey = (...parts: string[]) => crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);

export class JsonCache<V> {
  private data: Record<string, V>;
  private dirty = false;
  constructor(readonly file: string) {
    try {
      this.data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      this.data = {};
    }
  }
  get(k: string): V | undefined {
    return this.data[k];
  }
  set(k: string, v: V) {
    this.data[k] = v;
    this.dirty = true;
  }
  get size() {
    return Object.keys(this.data).length;
  }
  save() {
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Sorted keys keep diffs small and the file deterministic.
    const sorted = Object.fromEntries(Object.keys(this.data).sort().map((k) => [k, this.data[k]]));
    fs.writeFileSync(this.file, JSON.stringify(sorted, null, 1) + "\n");
    this.dirty = false;
  }
}

/** Live model calls are allowed only with SIEGE_REGEN=1 and a key. */
export const regenEnabled = (env = process.env) => env.SIEGE_REGEN === "1" && Boolean(env.ANTHROPIC_API_KEY);

export interface CachedVerdict {
  allow: boolean;
  reason: string;
  /** Wall time of the original API call, replayed into the reported latency. */
  ms: number;
}

export interface JudgeStats {
  calls: number;
  hits: number;
  live: number;
  /** Misses with no way to call the model: answered by the scripted judge and counted here. */
  uncached: number;
  /** Live calls that failed (budget, network): answered by the scripted judge, not cached. */
  errors: number;
}

/**
 * The Claude judge behind a cache keyed on the exact prompt. On a cache hit, `lastMs` maps the tx id
 * to the recorded API latency, so replayed runs report the latency the live run measured.
 */
export function cachedClaudeJudge(
  cache: JsonCache<CachedVerdict>,
  fallback: (tx: Tx, c: Constraints, cls: ClassifierResult) => JudgeVerdict,
  live: (tx: Tx, c: Constraints, cls: ClassifierResult) => Promise<JudgeVerdict> = llmJudge,
  canCall: () => boolean = regenEnabled,
) {
  const stats: JudgeStats = { calls: 0, hits: 0, live: 0, uncached: 0, errors: 0 };
  const lastMs = new Map<string, number>();
  const judge = async (tx: Tx, c: Constraints, cls: ClassifierResult): Promise<JudgeVerdict> => {
    stats.calls++;
    const key = hashKey(JUDGE_MODEL, JUDGE_CONFIG, JUDGE_SYSTEM, judgePrompt(tx, c, cls));
    const hit = cache.get(key);
    if (hit) {
      stats.hits++;
      lastMs.set(tx.id, hit.ms);
      return { allow: hit.allow, reason: hit.reason, source: "llm" };
    }
    if (!canCall()) {
      stats.uncached++;
      return fallback(tx, c, cls);
    }
    const t0 = performance.now();
    let v: JudgeVerdict;
    try {
      v = await live(tx, c, cls);
    } catch {
      stats.errors++;
      return fallback(tx, c, cls);
    }
    const ms = performance.now() - t0;
    stats.live++;
    // Live latency is already inside the guard's measured latency; lastMs is only for replays.
    cache.set(key, { allow: v.allow, reason: v.reason, ms: Math.round(ms) });
    return v;
  };
  return { judge, stats, lastMs };
}
