SHELL := /bin/bash
.PHONY: test test-core test-gateway test-app test-web test-public lint lint-public build-web dev build dev-weiboap build-weiboap format

# 不加任何 feature 的默认构建就是公开版。内部版（微博 WeiboAP 适配）一律显式加
# 这个 feature：漏加只会少一个 harness，立刻能发现；反过来用 --no-default-features
# 关内部特性，漏加就是把内部路径发出去，收不回来。
WEIBOAP := --features symsync-core/weiboap,symsync/weiboap

test: test-core test-gateway test-app lint build-web test-web

# 两种组合都要能编译、能跑
test-core:
	cargo test -p symsync-core
	cargo test -p symsync-core --features weiboap

test-gateway:
	cargo test -p symsync-gateway

# 应用壳里的纯逻辑（菜单栏面板的定位等）；不启动窗口
test-app:
	cargo test -p symsync --lib
	cargo test -p symsync --lib --features weiboap

test-web:
	node --test tests/*.test.ts

# 只跑公开版组合：发布公开版之前的把关，也是 CI 默认作业跑的东西
test-public: lint-public
	cargo test -p symsync-core

lint: lint-public
	cargo clippy --workspace --all-targets $(WEIBOAP) -- -D warnings

lint-public:
	cargo clippy --workspace --all-targets -- -D warnings
	node scripts/lint-ui.mjs

build-web:
	npm run build

dev:
	npm run tauri dev

build:
	npm run tauri build -- --debug

# 内部版：带 WeiboAP 适配
dev-weiboap:
	npm run tauri dev -- $(WEIBOAP)

build-weiboap:
	npm run tauri build -- --debug $(WEIBOAP)

format:
	cargo fmt --all
	npx --no-install prettier --write "src/**/*.{ts,tsx,css}"
