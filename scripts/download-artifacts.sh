#!/usr/bin/env bash
set -euo pipefail

# Download the five mirrored installers described in a probe manifest and verify
# both their exact byte sizes (fail-closed) and GCS MD5 hashes when recorded.
# All artifacts are public, unauthenticated objects on downloads.claude.ai (GCS).
#
# Usage: download-artifacts.sh <out-dir> <manifest-path>

out_dir="${1:-dist}"
manifest_path="${2:-}"
download_max_attempts="${DOWNLOAD_MAX_ATTEMPTS:-3}"
download_retry_delay="${DOWNLOAD_RETRY_DELAY_SECONDS:-3}"

if [[ -z "$manifest_path" ]]; then
  echo "Usage: download-artifacts.sh <out-dir> <manifest-path>" >&2
  exit 2
fi

if [[ ! -f "$manifest_path" ]]; then
  echo "Manifest not found: $manifest_path" >&2
  exit 1
fi

if [[ ! "$download_max_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "DOWNLOAD_MAX_ATTEMPTS must be a positive integer, got '$download_max_attempts'." >&2
  exit 2
fi

if [[ ! "$download_retry_delay" =~ ^[0-9]+$ ]]; then
  echo "DOWNLOAD_RETRY_DELAY_SECONDS must be a non-negative integer, got '$download_retry_delay'." >&2
  exit 2
fi

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require curl
require jq
require openssl

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
  if [[ ! "$expected" =~ ^[1-9][0-9]*$ ]]; then
    echo "Invalid or missing expected contentLength for $file: '${expected:-}'." >&2
    return 1
  fi
  actual="$(file_size "$file")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Downloaded size mismatch for $file: expected $expected bytes, got $actual bytes." >&2
    return 1
  fi
}

validate_md5() {
  local file="$1" expected_md5="$2" actual_md5
  if [[ -z "$expected_md5" || "$expected_md5" == "null" ]]; then
    return 0
  fi
  actual_md5="$(openssl dgst -md5 -binary "$file" | openssl base64 | tr -d '\r\n')"
  if [[ "$actual_md5" != "$expected_md5" ]]; then
    echo "Downloaded MD5 mismatch for $file: expected '$expected_md5', got '$actual_md5'." >&2
    return 1
  fi
}

download() {
  local jq_path="$1" output="$2"
  local url expected expected_md5 tmp_output attempt delay

  url="$(jq -r "${jq_path}.url // empty" "$manifest_path")"
  expected="$(jq -r "${jq_path}.contentLength // empty" "$manifest_path")"
  expected_md5="$(jq -r "${jq_path}.md5 // empty" "$manifest_path")"

  if [[ -z "$url" ]]; then
    echo "Missing url at ${jq_path} in $manifest_path" >&2
    exit 1
  fi
  if [[ ! "$expected" =~ ^[1-9][0-9]*$ ]]; then
    echo "Invalid or missing expected contentLength at ${jq_path} in $manifest_path: '${expected:-}'" >&2
    exit 1
  fi

  tmp_output="${output}.part"
  delay="$download_retry_delay"

  for ((attempt = 1; attempt <= download_max_attempts; attempt++)); do
    rm -f "$tmp_output"
    if ((attempt == 1)); then
      echo "Downloading $output: $url" >&2
    else
      echo "Downloading $output (attempt $attempt/$download_max_attempts): $url" >&2
    fi

    if curl -fL "${curl_retry_args[@]}" -o "$tmp_output" "$url" &&
       validate_size "$tmp_output" "$expected" &&
       validate_md5 "$tmp_output" "$expected_md5"; then
      mv -f "$tmp_output" "$output"
      return 0
    fi

    rm -f "$tmp_output" "$output"
    if ((attempt < download_max_attempts && delay > 0)); then
      sleep "$delay"
      delay=$((delay * 2))
    fi
  done

  echo "Failed to download and verify $output after $download_max_attempts attempt(s)." >&2
  exit 1
}

download '.sources.macos.universal' "$out_dir/Claude-mac-universal.dmg"
download '.sources.windows.x64'     "$out_dir/Claude-win-x64.msix"
download '.sources.windows.arm64'   "$out_dir/Claude-win-arm64.msix"
download '.sources.linux.x64'       "$out_dir/Claude-linux-x64.deb"
download '.sources.linux.arm64'     "$out_dir/Claude-linux-arm64.deb"

echo "Downloaded installers to $out_dir:" >&2
ls -l "$out_dir" >&2
