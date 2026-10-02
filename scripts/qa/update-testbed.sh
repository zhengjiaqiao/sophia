#!/bin/bash
# 应用内更新的测试环境（DESIGN「壳：侧栏 + 一块机面 › 更新键」「设置 › 检查更新」；
# docs/testing/2026-09-27-manual-test-cases.md「应用更新（APP）」）。
#
# 真的走一遍「查到 → 下载 → 装好 → 重启」：用一对测试密钥打两个 debug 包——旧版 0.0.1 与新版（当前版本号），
# 更新地址指向本机 http://127.0.0.1:$PORT/latest.json。正式配置一字不改：密钥、地址、版本号都经
# `tauri build --config` 临时覆盖。全部东西只写 /private/tmp/sophia-update-test（包括单独的 cargo target，
# 不碰仓库里的 target/，不影响正在跑的其他 Sophia）。
#
# 用法（在仓库根目录）：
#   scripts/qa/update-testbed.sh build            # 生成测试密钥、打新旧两个包（第一次要编译好几分钟）
#   scripts/qa/update-testbed.sh serve [模式]      # 起本机更新服务器；模式：
#                                                 #   update（默认）有新版
#                                                 #   broken         有新版，但下载地址是坏的（测下载失败 → 重试）
#                                                 #   latest         没有新版（测「已是最新版本」）
#   scripts/qa/update-testbed.sh start            # 放一份干净的旧版并启动（每次都从旧版开始）
#   scripts/qa/update-testbed.sh stop             # 关掉测试用的 Sophia 与更新服务器
#
# 启动用的是测试数据：没有 /private/tmp/sophia-qa/home 时先跑 scripts/qa/make-fixture.sh 建一份
# （debug 包才认 SOPHIA_TEST_HOME），不碰真实主目录。
set -euo pipefail

ROOT=/private/tmp/sophia-update-test
PORT=${PORT:-8787}
OLD_VERSION=0.0.1
REPO=$(cd "$(dirname "$0")/../.." && pwd)
NEW_VERSION=$(node -p "require('$REPO/src-tauri/tauri.conf.json').version")
TARGET="$ROOT/target"
BUNDLE="$TARGET/debug/bundle/macos"
QA_HOME=/private/tmp/sophia-qa/home

case "$(uname -m)" in
  arm64) PLATFORM=darwin-aarch64 ;;
  x86_64) PLATFORM=darwin-x86_64 ;;
  *) echo "只支持 macOS" >&2; exit 1 ;;
esac

# 覆盖配置：版本号 + 测试公钥 + 本机地址（http 要显式放行）+ 产出更新包。
# 应用标识另起一个：和本机正在用的 Sophia 分开（系统按标识认应用，同一个标识会被当成同一个应用）
write_config() { # write_config <版本> <文件>
  node -e '
    const [version, pubkey, port, out] = process.argv.slice(1);
    const conf = {
      version,
      identifier: "com.zhengjiaqiao.sophia.updatetest",
      bundle: { createUpdaterArtifacts: true },
      plugins: {
        updater: {
          pubkey,
          endpoints: [`http://127.0.0.1:${port}/latest.json`],
          dangerousInsecureTransportProtocol: true,
        },
      },
    };
    require("fs").writeFileSync(out, JSON.stringify(conf, null, 2));
  ' "$1" "$(cat "$ROOT/keys/test.key.pub")" "$PORT" "$2"
}

build_one() { # build_one <版本>
  write_config "$1" "$ROOT/conf-$1.json"
  (cd "$REPO" && CARGO_TARGET_DIR="$TARGET" \
    TAURI_SIGNING_PRIVATE_KEY="$(cat "$ROOT/keys/test.key")" \
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
    npx tauri build --debug --bundles app --config "$ROOT/conf-$1.json")
}

# latest.json：模式决定给什么
write_manifest() { # write_manifest <模式>
  local version="$NEW_VERSION" url="http://127.0.0.1:$PORT/Sophia.app.tar.gz"
  case "$1" in
    update) ;;
    broken) url="http://127.0.0.1:$PORT/missing.app.tar.gz" ;;
    latest) version="$OLD_VERSION" ;;
    *) echo "模式只有 update / broken / latest" >&2; exit 1 ;;
  esac
  node -e '
    const [version, url, sigFile, platform, out] = process.argv.slice(1);
    const fs = require("fs");
    const manifest = {
      version,
      notes: "测试环境",
      pub_date: new Date().toISOString(),
      platforms: { [platform]: { signature: fs.readFileSync(sigFile, "utf8").trim(), url } },
    };
    fs.writeFileSync(out, JSON.stringify(manifest, null, 2));
  ' "$version" "$url" "$ROOT/serve/Sophia.app.tar.gz.sig" "$PLATFORM" "$ROOT/serve/latest.json"
  echo "更新服务器：模式 $1（latest.json 版本 $version）"
}

stop_pid() { # stop_pid <pid 文件>
  if [ -f "$1" ]; then
    kill "$(cat "$1")" 2>/dev/null || true
    rm -f "$1"
  fi
}

cmd=${1:-}
case "$cmd" in
  build)
    mkdir -p "$ROOT/keys" "$ROOT/serve" "$ROOT/old"
    if [ ! -f "$ROOT/keys/test.key" ]; then
      (cd "$REPO" && npx tauri signer generate --ci -p "" -w "$ROOT/keys/test.key")
    fi
    echo "── 打新版 $NEW_VERSION ──"
    build_one "$NEW_VERSION"
    cp "$BUNDLE/Sophia.app.tar.gz" "$BUNDLE/Sophia.app.tar.gz.sig" "$ROOT/serve/"
    echo "── 打旧版 $OLD_VERSION ──"
    build_one "$OLD_VERSION"
    rm -rf "$ROOT/old/Sophia.app"
    cp -R "$BUNDLE/Sophia.app" "$ROOT/old/"
    echo "好了。接着：$0 serve，然后 $0 start"
    ;;
  serve)
    [ -f "$ROOT/serve/Sophia.app.tar.gz.sig" ] || { echo "先跑 $0 build" >&2; exit 1; }
    write_manifest "${2:-update}"
    # 服务器只起一次；换模式只改 latest.json
    if ! { [ -f "$ROOT/server.pid" ] && kill -0 "$(cat "$ROOT/server.pid")" 2>/dev/null; }; then
      nohup python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT/serve" \
        >"$ROOT/server.log" 2>&1 &
      echo $! >"$ROOT/server.pid"
      echo "已在 http://127.0.0.1:$PORT 起服务器（日志 $ROOT/server.log）"
    fi
    ;;
  start)
    [ -d "$ROOT/old/Sophia.app" ] || { echo "先跑 $0 build" >&2; exit 1; }
    [ -d "$QA_HOME" ] || "$REPO/scripts/qa/make-fixture.sh"
    stop_pid "$ROOT/app.pid"
    # 更新会原地换掉这个包：每次从一份干净的旧版开始
    rm -rf "$ROOT/app" && mkdir -p "$ROOT/app"
    cp -R "$ROOT/old/Sophia.app" "$ROOT/app/"
    SOPHIA_TEST_HOME="$QA_HOME" nohup "$ROOT/app/Sophia.app/Contents/MacOS/Sophia" \
      >"$ROOT/app.log" 2>&1 &
    echo $! >"$ROOT/app.pid"
    echo "已启动旧版 $OLD_VERSION（$ROOT/app/Sophia.app，日志 $ROOT/app.log）"
    ;;
  stop)
    stop_pid "$ROOT/app.pid"
    pkill -f "$ROOT/app/Sophia.app/Contents/MacOS/Sophia" 2>/dev/null || true
    stop_pid "$ROOT/server.pid"
    echo "已关掉测试用的 Sophia 与更新服务器"
    ;;
  *)
    sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
