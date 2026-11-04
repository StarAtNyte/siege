// Genetic search over attack sequences (TypeScript port of engine/siege_engine/evolve.py, used by the web app).
import { Arena, type Breach, type Gene, type GuardKind } from "./arena.ts";

const MAX_LEN = 14;

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = ReturnType<typeof rng>;
const ri = (r: Rng, n: number) => Math.floor(r() * n);
const choice = <T,>(r: Rng, xs: T[]) => xs[ri(r, xs.length)];

interface Ind {
  genome: Gene[];
  fitness: number;
  loss: number;
  breaches?: Breach[];
}

export interface Progress {
  guard: GuardKind;
  generation: number;
  generations: number;
  bestLoss: number;
  evaluations: number;
  /** The breaches of the best attack so far, so a caller can pin them to clauses as they are found. */
  breaches?: Breach[];
}

export interface SearchResult {
  guard: GuardKind;
  loss: number;
  genome: Gene[];
  history: number[];
  evaluations: number;
}

export class Search {
  private sizes: Arena["lib"]["sizes"];
  constructor(private arena: Arena, private guard: GuardKind, private seed = 0) {
    this.sizes = arena.lib.sizes;
  }

  private gene(r: Rng): Gene {
    const s = this.sizes;
    return {
      recipient: ri(r, s.recipient), user: ri(r, s.user), doc: r() < 0.25 ? -1 : ri(r, s.doc), reasoning: ri(r, s.reasoning),
      provenance: ri(r, s.provenance), memo: ri(r, s.memo), kind: ri(r, s.kind), method: ri(r, s.method), argRoute: ri(r, s.argRoute),
      concurrent: ri(r, 2), amount: Math.round(choice(r, [0.5, 0.9, 1, 2, 4.9, 5, 9.9, 10, 25]) * (0.8 + 0.4 * r()) * 100) / 100,
      dt: choice(r, [1, 5, 60, 600, 3600]),
    };
  }

  private mutateGene(g: Gene, r: Rng, rate: number): Gene {
    const out = { ...g };
    for (const k of Object.keys(this.sizes) as (keyof Arena["lib"]["sizes"])[]) {
      if (r() < rate) (out as unknown as Record<string, number>)[k] = k === "doc" && r() < 0.2 ? -1 : ri(r, this.sizes[k]);
    }
    if (r() < rate) out.amount = Math.max(0.01, Math.round(out.amount * choice(r, [0.5, 0.9, 0.99, 1.01, 1.1, 2]) * 100) / 100);
    if (r() < rate) out.dt = choice(r, [1, 5, 60, 600, 3600]);
    return out;
  }

  private mutate(genome: Gene[], r: Rng, rate: number): Gene[] {
    const g = genome.map((x) => this.mutateGene(x, r, rate));
    const op = r();
    if (op < 0.2 && g.length < MAX_LEN) g.splice(ri(r, g.length + 1), 0, this.gene(r));
    else if (op < 0.3 && g.length > 1) g.splice(ri(r, g.length), 1);
    else if (op < 0.45 && g.length < MAX_LEN) {
      const i = ri(r, g.length);
      g.splice(i + 1, 0, { ...g[i], concurrent: 1 }); // the race-condition move
    }
    return g;
  }

  private crossover(a: Gene[], b: Gene[], r: Rng): Gene[] {
    const child = [...a.slice(0, ri(r, a.length + 1)), ...b.slice(ri(r, b.length + 1))].slice(0, MAX_LEN);
    return child.length ? child.map((x) => ({ ...x })) : [this.gene(r)];
  }

  async run(generations = 30, popSize = 64, onProgress?: (p: Progress) => void, shouldStop?: () => boolean): Promise<SearchResult> {
    const r = rng(this.seed * 7919 + (this.guard === "mandate" ? 1 : 2));
    let pop: Ind[] = Array.from({ length: popSize }, () => ({ genome: Array.from({ length: 1 + ri(r, 6) }, () => this.gene(r)), fitness: -1, loss: 0 }));
    let best: Ind | undefined;
    const history: number[] = [];
    let evaluations = 0;
    for (let gen = 0; gen < generations; gen++) {
      if (shouldStop?.()) break;
      for (const p of pop) {
        if (p.fitness >= 0) continue;
        const res = await this.arena.evaluate(this.guard, p.genome);
        evaluations++;
        p.loss = res.loss;
        p.breaches = res.breaches;
        p.fitness = res.loss - 0.01 * p.genome.length; // parsimony keeps counterexamples readable
      }
      pop.sort((a, b) => b.fitness - a.fitness);
      if (!best || pop[0].fitness > best.fitness) best = { ...pop[0], genome: pop[0].genome.map((x) => ({ ...x })) };
      history.push(Math.max(0, best.loss));
      onProgress?.({ guard: this.guard, generation: gen, generations, bestLoss: Math.max(0, best.loss), evaluations, breaches: best.breaches ?? [] });
      const elite = pop.slice(0, Math.max(2, popSize >> 3));
      const next: Ind[] = elite.map((e) => ({ ...e }));
      const rate = gen < generations / 2 ? 0.25 : 0.1;
      while (next.length < popSize) {
        const a = choice(r, pop.slice(0, popSize >> 1)), b = choice(r, pop.slice(0, popSize >> 1));
        const parent = a.fitness > b.fitness ? a : b;
        const base = r() < 0.4 ? this.crossover(parent.genome, choice(r, elite).genome, r) : parent.genome.map((x) => ({ ...x }));
        next.push({ genome: this.mutate(base, r, rate), fitness: -1, loss: 0 });
      }
      pop = next;
      if (gen % 4 === 3) await new Promise((res) => setImmediate(res)); // keep the server responsive
    }
    return { guard: this.guard, loss: Math.max(0, best?.loss ?? 0), genome: best?.genome ?? [], history, evaluations };
  }
}
