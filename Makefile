.PHONY: install eval eval-heldout attack attack-llm redteam redteam-gen demo test replay
install:
	npm install
	cd engine && uv sync
eval:            ## reproduce the eval table (no API key needed)
	npx tsx src/eval/run.ts
attack:          ## evolutionary search for max extractable loss, plain policy vs Mandate
	cd engine && uv run siege-attack --generations 40 --pop 96 --seeds 3
attack-llm:      ## same search vs Mandate, plus the Claude mutation operator (replays results/redteam/mutation_cache.json)
	cd engine && uv run siege-attack --guards mandate --llm-mutations 12 --tag llm
redteam:         ## held-out eval on model-written attacks, replayed from results/redteam (no API key needed)
	npx tsx src/redteam/run.ts --split dev
	npx tsx src/redteam/run.ts --split test
	npx tsx src/redteam/run.ts --split test2
eval-heldout: redteam
redteam-gen:     ## regenerate cases: SIEGE_REGEN=1 plus ANTHROPIC_API_KEY (dev) or REDTEAM_BASE_URL/_API_KEY/_MODEL (test)
	npx tsx src/redteam/generate.ts --split $(SPLIT)
demo: eval attack
	npx tsx src/replay.ts results/attack_outlayer_open.json
test:
	node --import tsx --test test/*.test.ts
	npx tsc --noEmit
