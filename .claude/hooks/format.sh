#!/bin/bash
file=$(jq -r '.tool_input.file_path // empty' < /dev/stdin)
[[ -n "$file" && -f "$file" ]] || exit 0
case "$file" in
  *.rs) rustfmt --edition 2021 "$file" 2>/dev/null ;;
  *.ts|*.tsx|*.css) (cd "$CLAUDE_PROJECT_DIR" && npx --no-install prettier --write "$file" >/dev/null 2>&1) ;;
esac
exit 0
