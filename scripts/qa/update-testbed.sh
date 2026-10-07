#!/bin/bash
# 应用内更新的测试环境（DESIGN「壳：侧栏 + 一块机面 › 更新键」「设置 › 检查更新」；
# docs/testing/2026-09-27-manual-test-cases.md「应用更新（APP）」）。
#
# 真的走一遍「查到 → 下载 → 装好 → 重启」：用一对测试密钥打两个 debug 包——旧版 0.0.1 与新版（当前版本号），
# 更新有两条线路（issue #262）：http://127.0.0.1:$PORT 扮 GitHub，http://127.0.0.1:$((PORT+1)) 扮国内线路。
# 正式配置一字不改：密钥、地址、版本号都经 `tauri build --config` 临时覆盖。全部东西只写 /private/tmp/sophia-update-test（包括单独的 cargo target，
# 不碰仓库里的 target/，不影响正在跑的其他 Sophia）。
#
# 用法（在仓库根目录）：
#   scripts/qa/update-testbed.sh build            # 生成测试密钥、打新旧两个包（第一次要编译好几分钟）
#   scripts/qa/update-testbed.sh serve [模式]      # 起本机更新服务器；模式：
#                                                 #   update（默认）有新版
#                                                 #   broken         有新版，但两条线路的下载地址都是坏的（测下载失败 → 重试）
#                                                 #   latest         没有新版（测「已是最新版本」）
#                                                 #   github-down    GitHub 的清单不通，国内线路的好（测查清单换线路）
#                                                 #   package-down   GitHub 的清单好、包下不动，国内线路的好（测下载换线路）
#   scripts/qa/update-testbed.sh start            # 放一份干净的旧版并启动（每次都从旧版开始）
#   scripts/qa/update-testbed.sh stop             # 关掉测试用的 Sophia 与更新服务器
#
# 启动用的是测试数据：没有 /private/tmp/sophia-qa/home 时先跑 scripts/qa/make-fixture.sh 建一份
# （debug 包才认 SOPHIA_TEST_HOME），不碰真实主目录。
set -euo pipefail

ROOT=/private/tmp/sophia-update-test
PORT=${PORT:-8787}
CN_PORT=$((PORT + 1))
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

# 覆盖配置：版本号 + 测试公钥 + 两条本机线路（http 要显式放行）+ 产出更新包。
# 应用标识另起一个：和本机正在用的 Sophia 分开（系统按标识认应用，同一个标识会被当成同一个应用）
write_config() { # write_config <版本> <文件>
  node -e '
    const [version, pubkey, port, cnPort, out] = process.argv.slice(1);
    const conf = {
      version,
      identifier: "com.zhengjiaqiao.sophia.updatetest",
      bundle: { createUpdaterArtifacts: true },
      plugins: {
        updater: {
          pubkey,
          endpoints: [
            `http://127.0.0.1:${port}/latest.json`,
            `http://127.0.0.1:${cnPort}/latest.json`,
          ],
          dangerousInsecureTransportProtocol: true,
        },
      },
    };
    require("fs").writeFileSync(out, JSON.stringify(conf, null, 2));
  ' "$1" "$(cat "$ROOT/keys/test.key.pub")" "$PORT" "$CN_PORT" "$2"
}

build_one() { # build_one <版本>
  write_config "$1" "$ROOT/conf-$1.json"
  (cd "$REPO" && CARGO_TARGET_DIR="$TARGET" \
    TAURI_SIGNING_PRIVATE_KEY="$(cat "$ROOT/keys/test.key")" \
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
    npx tauri build --debug --bundles app --config "$ROOT/conf-$1.json")
}

# 一条线路的 latest.json；地址写 none 时不放清单（这条线路查清单回 404）
write_line() { # write_line <目录> <端口> <版本> <包文件名|none>
  rm -f "$1/latest.json"
  [ "$4" = none ] && return
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
  ' "$3" "http://127.0.0.1:$2/$4" "$1/Sophia.app.tar.gz.sig" "$PLATFORM" "$1/latest.json"
}

# 两条线路的 latest.json：模式决定给什么
write_manifest() { # write_manifest <模式>
  local version="$NEW_VERSION" github=Sophia.app.tar.gz cn=Sophia.app.tar.gz
  case "$1" in
    update) ;;
    broken) github=missing.app.tar.gz cn=missing.app.tar.gz ;;
    latest) version="$OLD_VERSION" ;;
    github-down) github=none ;;
    package-down) github=missing.app.tar.gz ;;
    *) echo "模式只有 update / broken / latest / github-down / package-down" >&2; exit 1 ;;
  esac
  write_line "$ROOT/serve" "$PORT" "$version" "$github"
  write_line "$ROOT/serve-cn" "$CN_PORT" "$version" "$cn"
  echo "更新服务器：模式 $1（版本 ${version}；GitHub 线路包 ${github}，国内线路包 ${cn}）"
}

serve_dir() { # serve_dir <目录> <端口> <pid 文件>
  if ! { [ -f "$3" ] && kill -0 "$(cat "$3")" 2>/dev/null; }; then
    nohup python3 -m http.server "$2" --bind 127.0.0.1 --directory "$1" \
      >"$1.log" 2>&1 &
    echo $! >"$3"
    echo "已在 http://127.0.0.1:$2 起服务器（日志 $1.log）"
  fi
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
    mkdir -p "$ROOT/keys" "$ROOT/serve" "$ROOT/serve-cn" "$ROOT/old"
    if [ ! -f "$ROOT/keys/test.key" ]; then
      (cd "$REPO" && npx tauri signer generate --ci -p "" -w "$ROOT/keys/test.key")
    fi
    echo "── 打新版 $NEW_VERSION ──"
    build_one "$NEW_VERSION"
    cp "$BUNDLE/Sophia.app.tar.gz" "$BUNDLE/Sophia.app.tar.gz.sig" "$ROOT/serve/"
    cp "$BUNDLE/Sophia.app.tar.gz" "$BUNDLE/Sophia.app.tar.gz.sig" "$ROOT/serve-cn/"
    echo "── 打旧版 $OLD_VERSION ──"
    build_one "$OLD_VERSION"
    rm -rf "$ROOT/old/Sophia.app"
    cp -R "$BUNDLE/Sophia.app" "$ROOT/old/"
    echo "好了。接着：$0 serve，然后 $0 start"
    ;;
  serve)
    [ -f "$ROOT/serve-cn/Sophia.app.tar.gz.sig" ] || { echo "先跑 $0 build" >&2; exit 1; }
    write_manifest "${2:-update}"
    # 服务器只起一次；换模式只改 latest.json。请求记录在 serve.log / serve-cn.log，看得出走了哪条线路
    serve_dir "$ROOT/serve" "$PORT" "$ROOT/server.pid"
    serve_dir "$ROOT/serve-cn" "$CN_PORT" "$ROOT/server-cn.pid"
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
    echo "已启动旧版 ${OLD_VERSION}（$ROOT/app/Sophia.app，日志 $ROOT/app.log）"
    ;;
  stop)
    stop_pid "$ROOT/app.pid"
    pkill -f "$ROOT/app/Sophia.app/Contents/MacOS/Sophia" 2>/dev/null || true
    stop_pid "$ROOT/server.pid"
    stop_pid "$ROOT/server-cn.pid"
    echo "已关掉测试用的 Sophia 与更新服务器"
    ;;
  *)
    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
