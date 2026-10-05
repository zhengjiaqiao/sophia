#!/usr/bin/env bash
# 核对 macOS 产物的签名与公证（spec 2026-10-05-signing-notarization R3）。
# release.yml 每个架构构建完调一次；本机签名公证后也用它核对。
#
# 用法：packaging/verify-signature.sh <Sophia.app> [<dmg>…]
#
# app 三条都要过：签名完整、Gatekeeper 认它是已公证的 Developer ID、票据已钉上。
# dmg 只打印结果不拦：用户打开 dmg 时 Gatekeeper 查的是里面的 app（spec 待决问题：dmg 要不要签）。
# 文件没有 quarantine 属性，这里绿了也不等于用户双击打得开——那一条只能在真机上带着 quarantine 验。
set -euo pipefail

app=${1:?用法：packaging/verify-signature.sh <Sophia.app> [<dmg>…]}
shift

echo "==> codesign：签名完整"
codesign --verify --deep --strict --verbose=2 "$app"

echo "==> spctl：Gatekeeper 的判断"
if ! assess=$(spctl --assess --type execute --verbose=4 "$app" 2>&1); then
  echo "$assess"
  echo "::error::Gatekeeper 拒绝了 $app"
  exit 1
fi
echo "$assess"
if ! grep -q 'source=Notarized Developer ID' <<<"$assess"; then
  echo "::error::Gatekeeper 不认它是已公证的 Developer ID 应用"
  exit 1
fi

echo "==> stapler：票据已钉上"
xcrun stapler validate "$app"

for dmg in "$@"; do
  echo "==> dmg（只看不拦）：$dmg"
  spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg" 2>&1 || true
done
