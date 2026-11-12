SHELL := /bin/bash
RUSTFLAGS_WASM = -C link-arg=-s -C target-cpu=mvp
# wasm-opt (binaryen) shrinks the wasm by ~20% and lowers bulk-memory/sign-ext ops to MVP; skipped if absent.
WASM_OPT ?= $(shell command -v wasm-opt 2>/dev/null)

.PHONY: test build
test:
	cargo test --quiet 2>&1 | grep -v '^EVENT_JSON' | grep -E 'test result|panicked|error' ; test $${PIPESTATUS[0]} -eq 0

build:
	RUSTFLAGS="$(RUSTFLAGS_WASM)" cargo build --target wasm32-unknown-unknown --release
	mkdir -p res
	@if [ -n "$(WASM_OPT)" ]; then \
	  $(WASM_OPT) -Oz --enable-bulk-memory-opt --llvm-memory-copy-fill-lowering --signext-lowering \
	    target/wasm32-unknown-unknown/release/siege_vault.wasm -o res/siege_vault.wasm; \
	else cp target/wasm32-unknown-unknown/release/siege_vault.wasm res/siege_vault.wasm; fi
	@ls -l res/siege_vault.wasm
