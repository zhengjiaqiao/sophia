SHELL := /bin/bash
.PHONY: test test-core test-gateway test-app test-web test-server test-public lint lint-public build-web dev build dev-weiboap build-weiboap format

# 不加任何 feature 的默认构建就是公开版。内部版（微博 WeiboAP 适配）一律显式加
# 这个 feature：漏加只会少一个 harness，立刻能发现；反过来用 --no-default-features
# 关内部特性，漏加就是把内部路径发出去，收不回来。
WEIBOAP := --features sophia-core/weiboap,sophia/weiboap

test: test-core test-gateway test-app lint build-web test-web

# 两种组合都要能编译、能跑
test-core:
	cargo test -p sophia-core
	cargo test -p sophia-core --features weiboap

test-gateway:
	cargo test -p sophia-gateway

# 应用壳里的纯逻辑（菜单栏面板的定位等）；不启动窗口
test-app:
	cargo test -p sophia --lib
	cargo test -p sophia --lib --features weiboap

test-web:
	node --test tests/*.test.ts

# 接收服务（server/，Cloudflare Worker）：本地 workerd + D1 跑测试，不连 Cloudflare。不在 make test 里
test-server:
	cd server && npm ci && npx tsc --noEmit && npx vitest run

# 只跑公开版组合：发布公开版之前的把关，也是 CI 默认作业跑的东西
test-public: lint-public
	cargo test -p sophia-core

lint: lint-public
	cargo clippy --workspace --all-targets $(WEIBOAP) -- -D warnings

lint-public:
	cargo clippy --workspace --all-targets -- -D warnings
	node scripts/lint-ui.mjs

build-web:
	npm run build

# 开发版换一个应用标识（DEV_CONFIG）：单实例按标识认，开发版与安装版同标识时后开的那个会静默退出
# （spec 2026-10-03-gateway-in-app 设计 §1）。正式打包（.github/workflows/release.yml）不带它
DEV_CONFIG := --config src-tauri/tauri.dev.conf.json

dev:
	npm run tauri dev -- $(DEV_CONFIG)

build:
	npm run tauri build -- --debug $(DEV_CONFIG)

# 内部版：带 WeiboAP 适配
dev-weiboap:
	npm run tauri dev -- $(DEV_CONFIG) $(WEIBOAP)

build-weiboap:
	npm run tauri build -- --debug $(DEV_CONFIG) $(WEIBOAP)

format:
	cargo fmt --all
	npx --no-install prettier --write "src/**/*.{ts,tsx,css}"
