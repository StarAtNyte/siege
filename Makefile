.PHONY: install eval eval-heldout attack attack-llm redteam redteam-gen demo test replay threat contract-test contract-build vault-vectors mcp
# The engine has no dependencies; once `make install` has made engine/.venv, run it directly. `uv run` needs a
# writable uv cache, which read-only sandboxes (e.g. Codex workspace-write) do not give it.
SIEGE_ATTACK = $(if $(wildcard engine/.venv/bin/siege-attack),.venv/bin/siege-attack,uv run siege-attack)
install:
	npm install
	cd engine && uv sync
eval:            ## reproduce the eval table (no API key needed)
	node --import tsx src/eval/run.ts
attack:          ## evolutionary search for max extractable loss, plain policy vs Mandate
	cd engine && $(SIEGE_ATTACK) --generations 40 --pop 96 --seeds 3
attack-llm:      ## same search vs Mandate, plus the Claude mutation operator (replays results/redteam/mutation_cache.json)
	cd engine && $(SIEGE_ATTACK) --guards mandate --llm-mutations 12 --tag llm
redteam:         ## held-out eval on model-written attacks, replayed from results/redteam (no API key needed)
	node --import tsx src/redteam/run.ts --split dev
	node --import tsx src/redteam/run.ts --split test
	node --import tsx src/redteam/run.ts --split test2
eval-heldout: redteam
redteam-gen:     ## regenerate cases: SIEGE_REGEN=1 plus ANTHROPIC_API_KEY (dev) or REDTEAM_BASE_URL/_API_KEY/_MODEL (test)
	node --import tsx src/redteam/generate.ts --split $(SPLIT)
demo: eval attack
	node --import tsx src/replay.ts results/attack_outlayer_open.json
threat:          ## two-key vault threat model: compromised agent vs compromised guard (results/vault_threat.*), plus the MCP path (results/mcp_threat.*)
	node --import tsx src/attack/threat.ts
	node --import tsx src/attack/threat_mcp.ts
mcp:             ## SIEGE MCP server over stdio (MANDATE, VAULT_KEYS_FILE / VAULT_CONTRACT: see src/mcp/server.ts)
	node --import tsx src/mcp/server.ts
vault-vectors:   ## regenerate contract/vectors/differential.json from the TS vault model
	node --import tsx src/vault/vectors.ts
contract-test:   ## vault contract unit tests (Rust)
	$(MAKE) -C contract test
contract-build:  ## vault contract wasm -> contract/res/siege_vault.wasm
	$(MAKE) -C contract build
test: contract-test
	node --import tsx --test test/*.test.ts
	npx tsc --noEmit
