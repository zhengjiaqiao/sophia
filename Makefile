SHELL := /bin/bash
.PHONY: test test-core test-gateway test-web lint build-web dev build format

test: test-core test-gateway lint build-web test-web

test-core:
	cargo test -p symsync-core

test-gateway:
	cargo test -p symsync-gateway

test-web:
	node --test tests/*.test.ts

lint:
	cargo clippy --workspace --all-targets -- -D warnings
	node scripts/lint-ui.mjs

build-web:
	npm run build

dev:
	npm run tauri dev

build:
	npm run tauri build -- --debug

format:
	cargo fmt --all
	npx --no-install prettier --write "src/**/*.{ts,tsx,css}"
