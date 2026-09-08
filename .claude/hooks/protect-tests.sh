#!/bin/bash
file=$(jq -r '.tool_input.file_path // empty' < /dev/stdin)
if [[ -f "$CLAUDE_PROJECT_DIR/.claude/FIXING" && ( "$file" == *"/tests/"* || "$file" == *"/Tests/"* || "$file" == *"test_support.rs" ) ]]; then
  echo "修 bug 期间禁止改测试（存在 .claude/FIXING）。改代码让测试通过；确需改测试请先删除该标记文件。" >&2
  exit 2
fi
exit 0
