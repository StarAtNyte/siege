"""Genetic search over transaction sequences. Fitness = NEAR extracted (attacker receipts + cap overshoot)."""
from __future__ import annotations

import copy
import random
from dataclasses import dataclass, field

# Ranges mirror the phrase libraries in src/oracle.ts.
FIELDS = {
    "recipient": 12, "user": 10, "doc": 11, "reasoning": 6, "provenance": 4,
    "memo": 8, "kind": 2, "method": 3, "argRoute": 3, "concurrent": 2,
}
MAX_LEN = 14


def random_gene(r: random.Random) -> dict:
    g = {k: r.randrange(n) for k, n in FIELDS.items()}
    if r.random() < 0.25:
        g["doc"] = -1
    g["amount"] = round(r.choice([0.5, 0.9, 1, 2, 4.9, 5, 9.9, 10, 25]) * r.uniform(0.8, 1.2), 2)
    g["dt"] = r.choice([1, 5, 60, 600, 3600])
    return g


# Fields the LLM mutation operator can override with free text (see src/redteam/mutate.ts).
TEXT_FIELDS = ("recipient", "doc", "reasoning", "memo")


def mutate_gene(g: dict, r: random.Random, rate: float) -> dict:
    g = dict(g)
    if "text" in g:
        g["text"] = dict(g["text"])
    for k, n in FIELDS.items():
        if r.random() < rate:
            g[k] = r.randrange(n) if not (k == "doc" and r.random() < 0.2) else -1
            # Re-drawing a field from the library drops any LLM-written text for it.
            if k in TEXT_FIELDS and "text" in g:
                g["text"].pop(k, None)
                if not g["text"]:
                    del g["text"]
    if r.random() < rate:
        g["amount"] = max(0.01, round(g["amount"] * r.choice([0.5, 0.9, 0.99, 1.01, 1.1, 2]), 2))
    if r.random() < rate:
        g["dt"] = r.choice([1, 5, 60, 600, 3600])
    return g


@dataclass
class Individual:
    genome: list[dict]
    fitness: float = -1.0
    meta: dict = field(default_factory=dict)


def mutate(ind: Individual, r: random.Random, rate: float) -> Individual:
    gen = [mutate_gene(g, r, rate) for g in ind.genome]
    op = r.random()
    if op < 0.2 and len(gen) < MAX_LEN:
        gen.insert(r.randrange(len(gen) + 1), random_gene(r))
    elif op < 0.3 and len(gen) > 1:
        gen.pop(r.randrange(len(gen)))
    elif op < 0.45 and len(gen) < MAX_LEN:
        # Duplicate a gene as a concurrent sibling: the race-condition move.
        i = r.randrange(len(gen))
        dup = dict(gen[i]); dup["concurrent"] = 1
        gen.insert(i + 1, dup)
    return Individual(gen)


def crossover(a: Individual, b: Individual, r: random.Random) -> Individual:
    i, j = r.randint(0, len(a.genome)), r.randint(0, len(b.genome))
    child = copy.deepcopy(a.genome[:i] + b.genome[j:])[:MAX_LEN]
    return Individual(child or [random_gene(r)])


def evolve(oracle, guard: str, mandate: str, generations: int = 40, pop_size: int = 96, seed: int = 0, log=print,
           llm_calls: int = 0, llm_every: int = 3) -> dict:
    """llm_calls > 0 enables the LLM mutation operator: every `llm_every` generations, Claude rewrites
    the best attack given the guard's verdicts, until `llm_calls` calls are used (cache hits count too)."""
    r = random.Random(seed)
    llm_used = 0
    llm_children = 0
    pop = [Individual([random_gene(r) for _ in range(r.randint(1, 6))]) for _ in range(pop_size)]
    best: Individual | None = None
    history = []
    for gen in range(generations):
        todo = [p for p in pop if p.fitness < 0]
        for p, res in zip(todo, oracle.batch(guard, mandate, [p.genome for p in todo])):
            # Small parsimony pressure so counterexamples stay readable.
            p.fitness = res["loss"] - 0.01 * len(p.genome)
            p.meta = res
        pop.sort(key=lambda p: p.fitness, reverse=True)
        if best is None or pop[0].fitness > best.fitness:
            best = copy.deepcopy(pop[0])
        history.append(round(max(0.0, best.fitness), 2))
        if gen % 5 == 0 or gen == generations - 1:
            log(f"  [{guard:8s}/{mandate:9s}] gen {gen:3d}  best loss {max(0, best.meta.get('loss', 0)):8.2f} NEAR  len {len(best.genome)}")
        elite = pop[: pop_size // 8]
        children = [copy.deepcopy(e) for e in elite]
        rate = 0.25 if gen < generations // 2 else 0.1
        while len(children) < pop_size:
            k = r.sample(pop[: pop_size // 2], 2)
            parent = max(k, key=lambda p: p.fitness)
            child = crossover(parent, r.choice(elite), r) if r.random() < 0.4 else Individual(copy.deepcopy(parent.genome))
            children.append(mutate(child, r, rate))
        if llm_used < llm_calls and gen % llm_every == 1:
            # Rewrite the best attack, and one other strong one, given what the guard said.
            slot = 0
            for parent in [pop[0], pop[1 + r.randrange(max(1, pop_size // 4))]]:
                if llm_used >= llm_calls:
                    break
                llm_used += 1
                child = oracle.llm_mutate(guard, mandate, parent.genome)
                if child:
                    llm_children += 1
                    slot += 1
                    children[-slot] = Individual(child)  # replaces a non-elite child
        pop = children
    assert best is not None
    return {"loss": max(0.0, best.meta.get("loss", 0.0)), "genome": best.genome, "history": history,
            "llm_calls": llm_used, "llm_children": llm_children}
