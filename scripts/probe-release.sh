#!/usr/bin/env bash
set -euo pipefail

# Probe the official Claude Desktop update API for the current release and build a
# release-manifest.json describing the three self-contained installers we mirror:
#   - macOS universal DMG
#   - Windows x64 MSIX
#   - Windows arm64 MSIX
#
# The version-independent redirect endpoints (no Cloudflare challenge, no auth) are:
#   https://api.anthropic.com/api/desktop/<platform>/<arch>/<format>/latest/redirect
# They 307 to the concrete artifact on downloads.claude.ai (Google Cloud Storage),
# whose path carries the version and a per-build content hash. That URL is the
# fingerprint: when it changes, there is a new build to mirror.
#
# Outputs (also written to GITHUB_OUTPUT when present):
#   should_release, release_tag, latest_tag, skip_reason, version_summary, manifest

update_api_base="${UPDATE_API_BASE:-https://api.anthropic.com}"
force_release="${FORCE_RELEASE:-false}"
release_tag_input="${RELEASE_TAG:-}"
manifest_path="${MANIFEST_PATH:-release-manifest.json}"

curl_retry_args=(
  --retry 5
  --retry-delay 2
  --retry-max-time 300
  --connect-timeout 20
  --max-time 120
  --retry-all-errors
)

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require curl
require jq
require gh

json_number() {
  if [[ "$1" =~ ^[0-9]+$ ]]; then printf '%s' "$1"; else printf '0'; fi
}

sanitize_tag_part() {
  tr -cs 'A-Za-z0-9._-' '-' <<<"$1" | sed -E 's/^-+//; s/-+$//'
}

# version_gt A B -> true when A is strictly greater than B (numeric, dotted).
version_gt() {
  [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" == "$1" ]]
}

# header_value <headers-blob> <header-name> -> the (last) value, case-insensitive.
header_value() {
  local headers="$1" name="$2"
  tr -d '\r' <<<"$headers" |
    awk -v wanted="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')" '
      BEGIN { value = "" }
      {
        line = $0
        lower = tolower(line)
        if (index(lower, wanted ":") == 1) {
          sub("^[^:]+:[[:space:]]*", "", line)
          value = line
        }
      }
      END { print value }
    '
}

# probe_one <platform> <arch> <format> -> prints a JSON object describing the asset.
probe_one() {
  local platform="$1" arch="$2" fmt="$3"
  local endpoint redirect_headers location file_name version build_hash
  local asset_headers content_length etag last_modified

  endpoint="$update_api_base/api/desktop/$platform/$arch/$fmt/latest/redirect"

  redirect_headers="$(curl -fsS -D - -o /dev/null "${curl_retry_args[@]}" "$endpoint")" ||
    { echo "Failed to fetch redirect: $endpoint" >&2; return 1; }
  location="$(header_value "$redirect_headers" "location")"
  if [[ -z "$location" ]]; then
    echo "No Location header from $endpoint" >&2
    return 1
  fi

  file_name="${location##*/}"
  version="$(awk -F/ '{ print $(NF-1) }' <<<"$location")"
  build_hash="${file_name#Claude-}"
  build_hash="${build_hash#ClaudeSetup-}"
  build_hash="${build_hash%.*}"

  if [[ -z "$version" || -z "$file_name" ]]; then
    echo "Could not parse version/filename from: $location" >&2
    return 1
  fi

  asset_headers="$(curl -fsSI -L "${curl_retry_args[@]}" "$location")" ||
    { echo "Failed to HEAD artifact: $location" >&2; return 1; }
  content_length="$(header_value "$asset_headers" "content-length")"
  etag="$(header_value "$asset_headers" "etag")"
  last_modified="$(header_value "$asset_headers" "last-modified")"

  jq -n \
    --arg platform "$platform" \
    --arg arch "$arch" \
    --arg format "$fmt" \
    --arg redirect "$endpoint" \
    --arg version "$version" \
    --arg url "$location" \
    --arg fileName "$file_name" \
    --arg buildHash "$build_hash" \
    --argjson contentLength "$(json_number "$content_length")" \
    --arg etag "$etag" \
    --arg lastModified "$last_modified" \
    '{
      platform: $platform,
      arch: $arch,
      format: $format,
      redirect: $redirect,
      version: $version,
      url: $url,
      fileName: $fileName,
      buildHash: $buildHash,
      contentLength: $contentLength,
      etag: $etag,
      lastModified: $lastModified
    }'
}

# Stable fingerprint used to detect "nothing changed" against the latest release.
# The artifact URL already embeds version + content hash, so it is sufficient.
manifest_key() {
  jq -S -c '{
    macos: { url: .sources.macos.universal.url, len: .sources.macos.universal.contentLength },
    win_x64: { url: .sources.windows.x64.url, len: .sources.windows.x64.contentLength },
    win_arm64: { url: .sources.windows.arm64.url, len: .sources.windows.arm64.contentLength }
  }' "$1"
}

mac_json="$(probe_one darwin universal dmg)"
win_x64_json="$(probe_one win32 x64 msix)"
win_arm64_json="$(probe_one win32 arm64 msix)"

version="$(jq -r '.version' <<<"$mac_json")"
win_x64_version="$(jq -r '.version' <<<"$win_x64_json")"
win_arm64_version="$(jq -r '.version' <<<"$win_arm64_json")"

if [[ -z "$version" || "$version" == "null" ]]; then
  echo "Missing macOS version from probe." >&2
  exit 1
fi

if [[ "$win_x64_version" != "$version" || "$win_arm64_version" != "$version" ]]; then
  echo "Note: platform versions differ (mac=$version win-x64=$win_x64_version win-arm64=$win_arm64_version); tagging by macOS version." >&2
fi

jq -n \
  --arg generatedAt "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  --arg updateApiBase "$update_api_base" \
  --arg version "$version" \
  --argjson mac "$mac_json" \
  --argjson winx64 "$win_x64_json" \
  --argjson winarm64 "$win_arm64_json" \
  '{
    schemaVersion: 1,
    generatedAt: $generatedAt,
    updateApiBase: $updateApiBase,
    version: $version,
    sources: {
      macos: { universal: $mac },
      windows: { x64: $winx64, arm64: $winarm64 }
    }
  }' > "$manifest_path"

should_release="true"
skip_reason=""
latest_tag=""
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

if [[ "$force_release" == "true" ]]; then
  skip_reason="force_release=true"
else
  latest_tag="$(gh release list --limit 1 --exclude-drafts --exclude-pre-releases --json tagName --jq '.[0].tagName // ""')"
  if [[ -n "$latest_tag" ]]; then
    if gh release download "$latest_tag" -p release-manifest.json -D "$tmp_dir" --clobber >/dev/null 2>&1; then
      previous_version="$(jq -r '.version // ""' "$tmp_dir/release-manifest.json")"
      if [[ "$(manifest_key "$manifest_path")" == "$(manifest_key "$tmp_dir/release-manifest.json")" ]]; then
        should_release="false"
        skip_reason="manifest matches latest release $latest_tag"
      elif [[ -n "$previous_version" ]] && version_gt "$previous_version" "$version"; then
        should_release="false"
        skip_reason="probed version $version is older than latest release $previous_version ($latest_tag); skipping"
      fi
    fi
  fi
fi

if [[ "$should_release" == "true" && "$force_release" != "true" && -z "$release_tag_input" ]]; then
  predicted_tag="claude-app-v$(sanitize_tag_part "$version")"
  if gh release view "$predicted_tag" >/dev/null 2>&1; then
    should_release="false"
    skip_reason="release tag $predicted_tag already exists"
  fi
fi

if [[ -n "$release_tag_input" ]]; then
  release_tag="$release_tag_input"
elif [[ "$force_release" == "true" ]]; then
  release_tag="claude-app-force-$(date -u +'%Y%m%d-%H%M%S')"
else
  release_tag=""
fi

version_summary="version=$version; mac=$(jq -r '.sources.macos.universal.contentLength' "$manifest_path")B; win-x64=$(jq -r '.sources.windows.x64.contentLength' "$manifest_path")B; win-arm64=$(jq -r '.sources.windows.arm64.contentLength' "$manifest_path")B"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "should_release=$should_release"
    echo "release_tag=$release_tag"
    echo "latest_tag=$latest_tag"
    echo "skip_reason=$skip_reason"
    echo "version_summary=$version_summary"
    echo "manifest<<EOF"
    cat "$manifest_path"
    echo "EOF"
  } >> "$GITHUB_OUTPUT"
fi

echo "should_release=$should_release"
echo "release_tag=$release_tag"
echo "latest_tag=$latest_tag"
echo "skip_reason=$skip_reason"
echo "version_summary=$version_summary"
