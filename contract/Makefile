SHELL := /bin/bash

# Reproducible build of the deployed vault (vault.darwin-siege-mw23cmc8.testnet, 80,021 bytes,
# code hash FhCBFTKPd2mA7E6vZwn78rz6Jyzx8FDRgH9XR5KSkmx2). The bytes depend on:
#   - the Rust toolchain: 1.97.1 (checked below; `rustup toolchain install 1.97.1 --target wasm32-unknown-unknown`,
#     then `RUSTUP_TOOLCHAIN=1.97.1 make contract-build` if it is not your default),
#   - the dependency versions: Cargo.lock (built with --locked),
#   - wasm-opt: binaryen 123, pinned as the npm devDependency `binaryen@123.0.0` (`npm install` at the repo root),
#   - panic-location strings: the deployed build embeds the paths of the machine that built it. The remaps below map
#     this machine's cargo home and toolchain to those paths, so any checkout on any machine yields the same bytes.
RUST_VERSION = 1.97.1
WASM_OPT = ../node_modules/.bin/wasm-opt
CARGO_HOME_DIR = $(or $(CARGO_HOME),$(HOME)/.cargo)
SYSROOT = $(shell rustc --print sysroot)
BUILT_CARGO_HOME = /home/nitiz/.cargo
BUILT_SYSROOT = /home/nitiz/.rustup/toolchains/stable-x86_64-unknown-linux-gnu
RUSTFLAGS_WASM = -C link-arg=-s -C target-cpu=mvp \
  --remap-path-prefix=$(CARGO_HOME_DIR)=$(BUILT_CARGO_HOME) --remap-path-prefix=$(SYSROOT)=$(BUILT_SYSROOT)
DEPLOYED_SHA256 = da4f7ca4146d00c74011cfee05b20d9220f9c8b37e99a51c388a5997f8f09a2f

.PHONY: test build verify
test:
	cargo test --quiet 2>&1 | grep -v '^EVENT_JSON' | grep -E 'test result|panicked|error' ; test $${PIPESTATUS[0]} -eq 0

build:
	@rustc --version | grep -q '^rustc $(RUST_VERSION) ' || { echo "contract-build needs rustc $(RUST_VERSION) for byte-identical output (found: $$(rustc --version)). rustup toolchain install $(RUST_VERSION) --target wasm32-unknown-unknown, then RUSTUP_TOOLCHAIN=$(RUST_VERSION) make contract-build"; exit 1; }
	@test -x $(WASM_OPT) || { echo "wasm-opt (binaryen 123) missing: run npm install at the repo root"; exit 1; }
	RUSTFLAGS="$(RUSTFLAGS_WASM)" cargo build --locked --target wasm32-unknown-unknown --release
	mkdir -p res
	# -Oz shrinks the wasm by about 20%; the lowering flags turn bulk-memory and sign-extension ops into MVP code.
	$(WASM_OPT) -Oz --enable-bulk-memory-opt --llvm-memory-copy-fill-lowering --signext-lowering \
	  target/wasm32-unknown-unknown/release/siege_vault.wasm -o res/siege_vault.wasm
	@$(MAKE) --no-print-directory verify

# Compare res/siege_vault.wasm with the deployed code. The on-chain side (base58 of the same sha256):
#   curl -s https://rpc.testnet.near.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query",
#     "params":{"request_type":"view_account","finality":"final","account_id":"vault.darwin-siege-mw23cmc8.testnet"}}'
#   -> result.code_hash = FhCBFTKPd2mA7E6vZwn78rz6Jyzx8FDRgH9XR5KSkmx2
verify:
	@ls -l res/siege_vault.wasm
	@sha=$$(sha256sum res/siege_vault.wasm | cut -d' ' -f1); \
	if [ "$$sha" = "$(DEPLOYED_SHA256)" ]; then echo "OK: sha256 $$sha matches the deployed vault (code hash FhCBFTKPd2mA7E6vZwn78rz6Jyzx8FDRgH9XR5KSkmx2)"; \
	else echo "MISMATCH: sha256 $$sha, deployed $(DEPLOYED_SHA256)"; exit 1; fi
