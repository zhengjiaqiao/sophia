SHELL := /bin/bash
.PHONY: test test-core lint build-web dev build format

test: test-core lint build-web

test-core:
	cargo test -p symsync-core

lint:
	cargo clippy --workspace --all-targets -- -D warnings

build-web:
	npm run build

dev:
	npm run tauri dev

build:
	npm run tauri build -- --debug

format:
	cargo fmt --all
	npx --no-install prettier --write "src/**/*.{ts,tsx,css}"
