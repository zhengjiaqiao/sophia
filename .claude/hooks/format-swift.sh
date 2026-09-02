#!/bin/bash
file=$(jq -r '.tool_input.file_path // empty' < /dev/stdin)
[[ "$file" == *.swift && -f "$file" ]] || exit 0
swift format -i "$file" 2>/dev/null
exit 0
