#!/usr/bin/env bash
set -euo pipefail

# Download the three mirrored installers described in a probe manifest and verify
# their byte sizes. All artifacts are public, unauthenticated objects on
# downloads.claude.ai (Google Cloud Storage).
#
# Usage: download-artifacts.sh <out-dir> <manifest-path>

out_dir="${1:-dist}"
manifest_path="${2:-}"

if [[ -z "$manifest_path" ]]; then
  echo "Usage: download-artifacts.sh <out-dir> <manifest-path>" >&2
  exit 2
fi

if [[ ! -f "$manifest_path" ]]; then
  echo "Manifest not found: $manifest_path" >&2
  exit 1
fi

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require curl
require jq

mkdir -p "$out_dir"

curl_retry_args=(
  --retry 5
  --retry-delay 2
  --retry-max-time 1800
  --connect-timeout 20
  --retry-all-errors
)

file_size() {
  if stat -f '%z' "$1" >/dev/null 2>&1; then
    stat -f '%z' "$1"
  else
    stat -c '%s' "$1"
  fi
}

validate_size() {
  local file="$1" expected="$2" actual
  if [[ -z "$expected" || "$expected" == "null" || "$expected" == "0" ]]; then
    return 0
  fi
  actual="$(file_size "$file")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Downloaded size mismatch for $file: expected $expected bytes, got $actual bytes." >&2
    exit 1
  fi
}

download() {
  local jq_path="$1" output="$2" url expected
  url="$(jq -r "${jq_path}.url" "$manifest_path")"
  expected="$(jq -r "${jq_path}.contentLength" "$manifest_path")"
  if [[ -z "$url" || "$url" == "null" ]]; then
    echo "Missing url at ${jq_path} in $manifest_path" >&2
    exit 1
  fi
  echo "Downloading $output: $url" >&2
  curl -fL "${curl_retry_args[@]}" -o "$output" "$url"
  validate_size "$output" "$expected"
}

download '.sources.macos.universal' "$out_dir/Claude-mac-universal.dmg"
download '.sources.windows.x64'     "$out_dir/Claude-win-x64.msix"
download '.sources.windows.arm64'   "$out_dir/Claude-win-arm64.msix"

echo "Downloaded installers to $out_dir:" >&2
ls -l "$out_dir" >&2
