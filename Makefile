SHELL := /bin/bash
.PHONY: test test-core test-gateway test-app test-web lint build-web dev build format

test: test-core test-gateway test-app lint build-web test-web

test-core:
	cargo test -p symsync-core

test-gateway:
	cargo test -p symsync-gateway

# 应用壳里的纯逻辑（菜单栏面板的定位等）；不启动窗口
test-app:
	cargo test -p symsync --lib

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
