#!/usr/bin/env bash
set -euo pipefail

# Strip the "latest quick downloads" blocks from a previous release's notes, so the
# R2 latest/* short links are only advertised on the newest release.

tag="${1:-}"

if [[ -z "$tag" ]]; then
  echo "Usage: $0 <release-tag>" >&2
  exit 2
fi

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

body_path="$tmp_dir/body.md"
updated_path="$tmp_dir/body-without-latest-links.md"

gh release view "$tag" --json body --jq '.body' > "$body_path"

python3 - "$body_path" "$updated_path" <<'PY'
import re
import sys
from pathlib import Path

source = Path(sys.argv[1])
target = Path(sys.argv[2])
body = source.read_text(encoding="utf-8")

patterns = [
    r"\n?<!-- latest-links-cn:start -->.*?<!-- latest-links-cn:end -->\n?",
    r"\n?<!-- latest-links-en:start -->.*?<!-- latest-links-en:end -->\n?",
]

updated = body
for pattern in patterns:
    updated = re.sub(pattern, "\n", updated, flags=re.DOTALL)

updated = re.sub(r"\n{3,}", "\n\n", updated).strip() + "\n"
target.write_text(updated, encoding="utf-8")
PY

if cmp -s "$body_path" "$updated_path"; then
  echo "No latest-link block found in $tag."
  exit 0
fi

gh release edit "$tag" --notes-file "$updated_path"
echo "Removed latest-link block from $tag."
