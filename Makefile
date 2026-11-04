.PHONY: install eval attack demo test replay
install:
	npm install
	cd engine && uv sync
eval:            ## reproduce the eval table (no API key needed)
	npx tsx src/eval/run.ts
attack:          ## evolutionary search for max extractable loss, plain policy vs Mandate
	cd engine && uv run siege-attack --generations 40 --pop 96 --seeds 3
demo: eval attack
	npx tsx src/replay.ts results/attack_outlayer_open.json
test:
	node --import tsx --test test/*.test.ts
	npx tsc --noEmit
