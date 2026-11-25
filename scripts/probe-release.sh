#!/usr/bin/env bash
set -euo pipefail

# Probe the official Claude Desktop update API for the current release and build a
# release-manifest.json describing the five self-contained installers we mirror:
#   - macOS universal DMG
#   - Windows x64 MSIX
#   - Windows arm64 MSIX
#   - Linux x64 deb
#   - Linux arm64 deb
#
# Outputs (also written to GITHUB_OUTPUT when present):
#   should_release, release_tag, latest_tag, skip_reason, version_summary, manifest

update_api_base="${UPDATE_API_BASE:-https://api.anthropic.com}"
update_api_base="${update_api_base%/}"
r2_public_base_url="${R2_PUBLIC_BASE_URL:-}"
r2_public_base_url="${r2_public_base_url%/}"
r2_origin_base_url="${R2_ORIGIN_BASE_URL:-$r2_public_base_url}"
r2_origin_base_url="${r2_origin_base_url%/}"
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
require openssl

sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print tolower($1) }'
  else
    shasum -a 256 "$1" | awk '{ print tolower($1) }'
  fi
}

validate_version_token() {
  local label="$1" value="$2"
  if [[ ! "$value" =~ ^[0-9][A-Za-z0-9._-]{0,63}$ ]] || [[ "$value" == *".."* ]]; then
    echo "Invalid $label: '$value'" >&2
    exit 1
  fi
}

validate_release_tag() {
  local value="$1"
  if [[ ! "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || [[ "$value" == *".."* ]]; then
    echo "Invalid release tag: '$value'" >&2
    exit 1
  fi
}

if [[ -n "$release_tag_input" ]]; then
  validate_release_tag "$release_tag_input"
fi

json_number() {
  if [[ "$1" =~ ^[0-9]+$ ]]; then printf '%s' "$1"; else printf '0'; fi
}

sanitize_tag_part() {
  tr -cs 'A-Za-z0-9._-' '-' <<<"$1" | sed -E 's/^-+//; s/-+$//'
}

# version_gt A B -> true when A is strictly greater than B.
# Compares dotted numeric core segments as integers first; for identical cores,
# a final release (no hyphen suffix) sorts higher than a prerelease (-rc.1, -beta, etc.),
# and prerelease dot-separated tokens compare numeric tokens numerically (rc.10 > rc.2).
version_gt() {
  awk -v a="$1" -v b="$2" '
    function cmp_uint(x, y,   nx, ny) {
      nx = "" x; sub(/^0+/, "", nx); if (nx == "") nx = "0"
      ny = "" y; sub(/^0+/, "", ny); if (ny == "") ny = "0"
      if (length(nx) != length(ny)) return (length(nx) > length(ny) ? 1 : -1)
      if (("" nx) == ("" ny)) return 0
      return (("" nx) > ("" ny) ? 1 : -1)
    }
    function split_ver(v, out,   idx, sv) {
      sv = "" v
      idx = index(sv, "-")
      if (idx > 0) {
        out["core"] = substr(sv, 1, idx - 1)
        out["pre"] = substr(sv, idx + 1)
      } else {
        out["core"] = sv
        out["pre"] = ""
      }
    }
    BEGIN {
      if (("" a) == ("" b)) exit 1
      split_ver(a, va)
      split_ver(b, vb)
      na = split(va["core"], pa, ".")
      nb = split(vb["core"], pb, ".")
      n = (na > nb ? na : nb)
      for (i = 1; i <= n; i++) {
        ca = (i <= na ? "" pa[i] : "0")
        cb = (i <= nb ? "" pb[i] : "0")
        if (ca ~ /^[0-9]+$/ && cb ~ /^[0-9]+$/) {
          cmp = cmp_uint(ca, cb)
          if (cmp != 0) exit (cmp > 0 ? 0 : 1)
        } else if (("" ca) != ("" cb)) {
          exit (("" ca) > ("" cb) ? 0 : 1)
        }
      }
      if (("" va["pre"]) == "" && ("" vb["pre"]) != "") exit 0
      if (("" va["pre"]) != "" && ("" vb["pre"]) == "") exit 1
      if (("" va["pre"]) == "" && ("" vb["pre"]) == "") exit 1
      ma = split(va["pre"], qa, ".")
      mb = split(vb["pre"], qb, ".")
      m = (ma > mb ? ma : mb)
      for (j = 1; j <= m; j++) {
        if (j > ma) exit 1
        if (j > mb) exit 0
        ta = "" qa[j]
        tb = "" qb[j]
        a_num = (ta ~ /^[0-9]+$/)
        b_num = (tb ~ /^[0-9]+$/)
        if (a_num && b_num) {
          cmp = cmp_uint(ta, tb)
          if (cmp != 0) exit (cmp > 0 ? 0 : 1)
        } else if (a_num != b_num) {
          exit (a_num ? 1 : 0)
        } else if (("" ta) != ("" tb)) {
          exit (("" ta) > ("" tb) ? 0 : 1)
        }
      }
      exit 1
    }
  '
}

# manifest_downgrades_from <reference-manifest> <candidate-manifest>
# Prints "<slot>:<ref_ver>-><cand_ver>" and returns 0 when ANY platform or top-level
# version in <reference-manifest> is strictly newer than <candidate-manifest>.
manifest_downgrades_from() {
  local ref_manifest="$1" cand_manifest="$2"
  local spec slot jq_expr ref_ver cand_ver
  for spec in \
    "version:.version" \
    "macos/universal:.sources.macos.universal.version" \
    "windows/x64:.sources.windows.x64.version" \
    "windows/arm64:.sources.windows.arm64.version" \
    "linux/x64:.sources.linux.x64.version" \
    "linux/arm64:.sources.linux.arm64.version"; do
    slot="${spec%%:*}"
    jq_expr="${spec#*:}"
    ref_ver="$(jq -r "$jq_expr // \"\"" "$ref_manifest" 2>/dev/null || true)"
    cand_ver="$(jq -r "$jq_expr // \"\"" "$cand_manifest" 2>/dev/null || true)"
    if [[ -n "$ref_ver" ]]; then
      validate_version_token "reference $slot" "$ref_ver"
      if [[ -z "$cand_ver" ]] || version_gt "$ref_ver" "$cand_ver"; then
        printf '%s (%s < %s)' "$slot" "${cand_ver:-missing}" "$ref_ver"
        return 0
      fi
    fi
  done
  return 1
}

resolve_latest_release_tag() {
  local out_file err_file parsed_tag="" err_text=""
  out_file="$(mktemp)"
  err_file="$(mktemp)"
  if gh release view --json tagName >"$out_file" 2>"$err_file"; then
    if ! parsed_tag="$(jq -er '.tagName // .tag_name | select(type == "string" and length > 0)' "$out_file" 2>/dev/null)"; then
      echo "Malformed JSON from 'gh release view --json tagName' (/releases/latest); failing closed." >&2
      rm -f "$out_file" "$err_file"
      exit 1
    fi
    rm -f "$out_file" "$err_file"
    printf '%s' "$parsed_tag"
    return 0
  fi
  err_text="$(cat "$err_file")"
  rm -f "$out_file" "$err_file"
  if grep -Eiq 'HTTP [54][0-9]{2}|Service Unavailable|Bad Gateway|Gateway Timeout|Internal Server Error|timed out|connection refused|TLS handshake' <<<"$err_text" &&
     ! grep -Eiq 'HTTP 404' <<<"$err_text"; then
    echo "Failed querying GitHub latest release (/releases/latest): $err_text" >&2
    exit 1
  fi
  if ! grep -Eiq '^release not found$|HTTP 404' <<<"$err_text"; then
    echo "Failed querying GitHub latest release (/releases/latest): $err_text" >&2
    exit 1
  fi
  gh release list --limit 1 --exclude-drafts --exclude-pre-releases --json tagName --jq '.[0].tagName // ""'
}

gh_release_exists() {
  local tag="$1" err=""
  if err="$(gh release view "$tag" --json tagName 2>&1 >/dev/null)"; then
    return 0
  fi
  if grep -Eiq 'HTTP [54][0-9]{2}|Service Unavailable|Bad Gateway|Gateway Timeout|Internal Server Error|timed out|connection refused|TLS handshake' <<<"$err" &&
     ! grep -Eiq 'HTTP 404' <<<"$err"; then
    echo "Failed querying GitHub release '$tag': $err" >&2
    exit 1
  fi
  if grep -Eiq '^release not found$|HTTP 404' <<<"$err"; then
    return 1
  fi
  echo "Failed querying GitHub release '$tag': $err" >&2
  exit 1
}

# last_header_block <headers-blob> -> prints only the final HTTP response's headers (CR stripped).
last_header_block() {
  tr -d '\r' <<<"$1" |
    awk '
      /^HTTP\/[0-9.]+[[:space:]]+[0-9]+/ { block = $0 "\n"; next }
      { block = block $0 "\n" }
      END { printf "%s", block }
    '
}

http_status_code() {
  tr -d '\r' <<<"$1" |
    awk '
      /^HTTP\/[0-9.]+[[:space:]]+[0-9]+/ { code = $2 }
      END { printf "%s", code }
    '
}

# header_value <headers-blob> <header-name> -> the (last) value, case-insensitive, trimmed.
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
          sub("[[:space:]]+$", "", line)
          value = line
        }
      }
      END { print value }
    '
}

# gcs_md5_base64 <final-headers-blob> -> extracts validated 16-byte base64 MD5 from x-goog-hash.
# Rejects conflicting non-empty MD5 values or malformed Base64 lengths.
gcs_md5_base64() {
  local headers="$1" stored_encoding raw_md5 decoded_len
  stored_encoding="$(header_value "$headers" "x-goog-stored-content-encoding" | tr '[:upper:]' '[:lower:]')"
  if [[ -n "$stored_encoding" && "$stored_encoding" != "identity" ]]; then
    printf '%s' ""
    return 0
  fi

  if ! raw_md5="$(
    tr -d '\r' <<<"$headers" |
      awk '
        BEGIN { md5 = ""; conflict = 0 }
        {
          line = $0
          lower = tolower(line)
          if (index(lower, "x-goog-hash:") == 1) {
            sub("^[^:]+:[[:space:]]*", "", line)
            n = split(line, parts, ",")
            for (i = 1; i <= n; i++) {
              part = parts[i]
              sub("^[[:space:]]+", "", part)
              sub("[[:space:]]+$", "", part)
              if (index(tolower(part), "md5=") == 1) {
                candidate = substr(part, 5)
                sub("^[[:space:]]+", "", candidate)
                sub("[[:space:]]+$", "", candidate)
                if (candidate != "") {
                  if (md5 != "" && md5 != candidate) {
                    conflict = 1
                  }
                  md5 = candidate
                }
              }
            }
          }
        }
        END {
          if (conflict) exit 1
          printf "%s", md5
        }
      '
  )"; then
    echo "Conflicting x-goog-hash MD5 headers detected." >&2
    return 1
  fi

  if [[ -z "$raw_md5" ]]; then
    printf '%s' ""
    return 0
  fi

  decoded_len="$(printf '%s' "$raw_md5" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d '[:space:]')" || decoded_len="0"
  if [[ "$decoded_len" != "16" ]]; then
    echo "Malformed x-goog-hash MD5 Base64 ('$raw_md5', decoded $decoded_len bytes)." >&2
    return 1
  fi

  printf '%s' "$raw_md5"
}

# probe_one <platform> <arch> <format> -> prints a JSON object describing the asset.
probe_one() {
  local platform="$1" arch="$2" fmt="$3"
  local endpoint redirect_headers location file_name version build_hash
  local asset_headers final_headers content_length etag last_modified gcs_md5

  endpoint="$update_api_base/api/desktop/$platform/$arch/$fmt/latest/redirect"

  redirect_headers="$(curl -fsS -D - -o /dev/null "${curl_retry_args[@]}" "$endpoint")" ||
    { echo "Failed to fetch redirect: $endpoint" >&2; return 1; }
  location="$(header_value "$(last_header_block "$redirect_headers")" "location")"
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
  validate_version_token "$platform/$arch version" "$version"

  asset_headers="$(curl -fsSI -L "${curl_retry_args[@]}" "$location")" ||
    { echo "Failed to HEAD artifact: $location" >&2; return 1; }
  final_headers="$(last_header_block "$asset_headers")"
  content_length="$(header_value "$final_headers" "content-length")"
  if [[ ! "$content_length" =~ ^[1-9][0-9]*$ ]]; then
    echo "Missing or invalid Content-Length ('$content_length') from $location" >&2
    return 1
  fi
  etag="$(header_value "$final_headers" "etag")"
  last_modified="$(header_value "$final_headers" "last-modified")"
  gcs_md5="$(gcs_md5_base64 "$final_headers")" || return 1

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
    --arg md5 "$gcs_md5" \
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
      lastModified: $lastModified,
      md5: $md5
    }'
}

# Compare two manifests: URLs and byte lengths must match across all 5 platforms,
# and whenever BOTH manifests record a non-empty MD5 for a platform, MD5 must match too
# (preserving compatibility with older published manifests that predate .md5).
manifests_match() {
  local left="$1" right="$2"
  jq -e -n --slurpfile a "$left" --slurpfile b "$right" '
    def entry_eq($x; $y):
      ($x.url == $y.url)
      and ($x.contentLength == $y.contentLength)
      and (((($x.md5 // "") == "") or (($y.md5 // "") == "")) or ($x.md5 == $y.md5));
    ($a[0].sources) as $sa
    | ($b[0].sources) as $sb
    | (($a[0].version // "") == ($b[0].version // ""))
      and entry_eq($sa.macos.universal; $sb.macos.universal)
      and entry_eq($sa.windows.x64; $sb.windows.x64)
      and entry_eq($sa.windows.arm64; $sb.windows.arm64)
      and entry_eq($sa.linux.x64; $sb.linux.x64)
      and entry_eq($sa.linux.arm64; $sb.linux.arm64)
  ' >/dev/null 2>&1
}

manifest_fingerprint_sha256() {
  local file="$1" tmp_fp
  tmp_fp="$(mktemp)"
  jq -S -c '{
    macos: { url: .sources.macos.universal.url, len: .sources.macos.universal.contentLength, md5: (.sources.macos.universal.md5 // "") },
    win_x64: { url: .sources.windows.x64.url, len: .sources.windows.x64.contentLength, md5: (.sources.windows.x64.md5 // "") },
    win_arm64: { url: .sources.windows.arm64.url, len: .sources.windows.arm64.contentLength, md5: (.sources.windows.arm64.md5 // "") },
    linux_x64: { url: .sources.linux.x64.url, len: .sources.linux.x64.contentLength, md5: (.sources.linux.x64.md5 // "") },
    linux_arm64: { url: .sources.linux.arm64.url, len: .sources.linux.arm64.contentLength, md5: (.sources.linux.arm64.md5 // "") }
  }' "$file" > "$tmp_fp"
  sha256_hex "$tmp_fp"
  rm -f "$tmp_fp"
}

mirror_object_size() {
  local url="$1" headers final_headers status cr cl
  if headers="$(curl -sSI -L --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 60 "$url")"; then
    final_headers="$(last_header_block "$headers")"
    status="$(http_status_code "$final_headers")"
    if [[ "$status" == "200" ]]; then
      cl="$(header_value "$final_headers" "content-length")"
      if [[ "$cl" =~ ^[1-9][0-9]*$ ]]; then
        printf '%s' "$cl"
        return 0
      fi
    elif [[ "$status" != "403" && "$status" != "405" && "$status" != "501" ]]; then
      return 1
    fi
  fi

  local hfile
  hfile="$(mktemp)"
  if curl -fsSL -L "${curl_retry_args[@]}" --range 0-0 --max-filesize 1048576 -D "$hfile" -o /dev/null "$url"; then
    final_headers="$(last_header_block "$(cat "$hfile")")"
    rm -f "$hfile"
    status="$(http_status_code "$final_headers")"
    cr="$(header_value "$final_headers" "content-range")"
    if [[ "$status" == "206" && "$cr" =~ ^bytes[[:space:]]+[0-9]+-[0-9]+/([1-9][0-9]*)$ ]]; then
      printf '%s' "${BASH_REMATCH[1]}"
      return 0
    fi
    if [[ "$status" == "200" && -z "$cr" ]]; then
      cl="$(header_value "$final_headers" "content-length")"
      if [[ "$cl" =~ ^[1-9][0-9]*$ ]]; then
        printf '%s' "$cl"
        return 0
      fi
    fi
  fi
  rm -f "$hfile"
  return 1
}

public_mirror_latest_matches() {
  local expected_manifest="$1"
  local expected_tag="${2:-}"
  local gh_release_manifest="${3:-}"
  if [[ -z "$r2_public_base_url" ]]; then
    return 0
  fi

  local dir live_manifest live_checksums actual_size expected_size live_manifest_sha live_release_tag auth_manifest
  dir="$(mktemp -d)"
  live_manifest="$dir/live-manifest.json"
  live_checksums="$dir/live-checksums.txt"

  if ! curl -fsSL --retry 3 --retry-delay 1 --connect-timeout 20 --max-time 60 "$r2_public_base_url/latest/manifest?probe=$$" -o "$live_manifest" ||
     ! manifests_match "$expected_manifest" "$live_manifest" ||
     ! curl -fsSL --retry 3 --retry-delay 1 --connect-timeout 20 --max-time 60 "$r2_public_base_url/latest/checksums?probe=$$" -o "$live_checksums"; then
    rm -rf "$dir"
    return 1
  fi

  if [[ -n "$gh_release_manifest" && -f "$gh_release_manifest" ]]; then
    if ! cmp -s "$gh_release_manifest" "$live_manifest"; then
      rm -rf "$dir"
      return 1
    fi
    auth_manifest="$gh_release_manifest"
    local gh_release_tag
    gh_release_tag="$(jq -r '.releaseTag // ""' "$gh_release_manifest")"
    if [[ -n "$expected_tag" && -n "$gh_release_tag" && "$gh_release_tag" != "$expected_tag" ]]; then
      rm -rf "$dir"
      return 1
    fi
  else
    auth_manifest="$live_manifest"
    if [[ -n "$expected_tag" ]]; then
      live_release_tag="$(jq -r '.releaseTag // ""' "$live_manifest")"
      if [[ "$live_release_tag" != "$expected_tag" ]]; then
        rm -rf "$dir"
        return 1
      fi
    fi
  fi

  live_manifest_sha="$(sha256_hex "$live_manifest")"
  if ! awk -v manifest_sha="$live_manifest_sha" '
    NF == 0 { next }
    {
      digest = tolower($1)
      name = $0
      sub(/^[^[:space:]]+[[:space:]]+\*?/, "", name)
      if (digest !~ /^[0-9a-f]{64}$/ || name == "" || (name in seen)) exit 1
      seen[name] = digest
      count++
    }
    END {
      if (count != 6) exit 1
      if (seen["release-manifest.json"] != manifest_sha) exit 1
      if (!("Claude-mac-universal.dmg" in seen)) exit 1
      if (!("Claude-win-x64.msix" in seen)) exit 1
      if (!("Claude-win-arm64.msix" in seen)) exit 1
      if (!("Claude-linux-x64.deb" in seen)) exit 1
      if (!("Claude-linux-arm64.deb" in seen)) exit 1
    }
  ' "$live_checksums"; then
    rm -rf "$dir"
    return 1
  fi

  local sha_spec asset_name jq_sha expected_sha
  for sha_spec in \
    "Claude-mac-universal.dmg:.sources.macos.universal.sha256" \
    "Claude-win-x64.msix:.sources.windows.x64.sha256" \
    "Claude-win-arm64.msix:.sources.windows.arm64.sha256" \
    "Claude-linux-x64.deb:.sources.linux.x64.sha256" \
    "Claude-linux-arm64.deb:.sources.linux.arm64.sha256"; do
    asset_name="${sha_spec%%:*}"
    jq_sha="${sha_spec#*:}"
    expected_sha="$(jq -r "$jq_sha // \"\"" "$auth_manifest" | tr '[:upper:]' '[:lower:]')"
    if [[ ! "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || ! grep -Fiq "${expected_sha}  ${asset_name}" "$live_checksums"; then
      rm -rf "$dir"
      return 1
    fi
  done

  local pair alias_path jq_len
  for pair in \
    "latest/mac:.sources.macos.universal.contentLength" \
    "latest/win-x64:.sources.windows.x64.contentLength" \
    "latest/win-arm64:.sources.windows.arm64.contentLength" \
    "latest/linux-x64:.sources.linux.x64.contentLength" \
    "latest/linux-arm64:.sources.linux.arm64.contentLength"; do
    alias_path="${pair%%:*}"
    jq_len="${pair#*:}"
    expected_size="$(jq -r "$jq_len // 0" "$expected_manifest")"
    if ! actual_size="$(mirror_object_size "$r2_origin_base_url/$alias_path?probe=$$")" ||
       [[ "$actual_size" != "$expected_size" ]]; then
      rm -rf "$dir"
      return 1
    fi
  done

  rm -rf "$dir"
  return 0
}

mac_json="$(probe_one darwin universal dmg)"
win_x64_json="$(probe_one win32 x64 msix)"
win_arm64_json="$(probe_one win32 arm64 msix)"
linux_x64_json="$(probe_one linux x64 deb)"
linux_arm64_json="$(probe_one linux arm64 deb)"

version="$(jq -r '.version' <<<"$mac_json")"
win_x64_version="$(jq -r '.version' <<<"$win_x64_json")"
win_arm64_version="$(jq -r '.version' <<<"$win_arm64_json")"
linux_x64_version="$(jq -r '.version' <<<"$linux_x64_json")"
linux_arm64_version="$(jq -r '.version' <<<"$linux_arm64_json")"

if [[ -z "$version" || "$version" == "null" ]]; then
  echo "Missing macOS version from probe." >&2
  exit 1
fi

if [[ "$win_x64_version" != "$version" || "$win_arm64_version" != "$version" ||
      "$linux_x64_version" != "$version" || "$linux_arm64_version" != "$version" ]]; then
  echo "Note: platform versions differ (mac=$version win-x64=$win_x64_version win-arm64=$win_arm64_version linux-x64=$linux_x64_version linux-arm64=$linux_arm64_version); tagging by macOS version." >&2
fi

jq -n \
  --arg generatedAt "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  --arg updateApiBase "$update_api_base" \
  --arg version "$version" \
  --argjson mac "$mac_json" \
  --argjson winx64 "$win_x64_json" \
  --argjson winarm64 "$win_arm64_json" \
  --argjson linuxx64 "$linux_x64_json" \
  --argjson linuxarm64 "$linux_arm64_json" \
  '{
    schemaVersion: 1,
    generatedAt: $generatedAt,
    updateApiBase: $updateApiBase,
    version: $version,
    sources: {
      macos: { universal: $mac },
      windows: { x64: $winx64, arm64: $winarm64 },
      linux: { x64: $linuxx64, arm64: $linuxarm64 }
    }
  }' > "$manifest_path"

should_release="true"
repair_r2_only="false"
downgraded="false"
skip_reason=""
latest_tag=""
release_tag_fallback=""
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

if [[ "$force_release" == "true" ]]; then
  skip_reason="force_release=true"
else
  latest_tag="$(resolve_latest_release_tag)"
  if [[ -n "$latest_tag" ]]; then
    if ! gh release download "$latest_tag" -p release-manifest.json -D "$tmp_dir" --clobber >/dev/null 2>&1; then
      echo "Failed to download release-manifest.json from latest release $latest_tag; failing closed." >&2
      exit 1
    fi
    previous_version="$(jq -r '.version // ""' "$tmp_dir/release-manifest.json")"
    downgrade_detail=""
    if manifests_match "$manifest_path" "$tmp_dir/release-manifest.json"; then
      if public_mirror_latest_matches "$manifest_path" "$latest_tag" "$tmp_dir/release-manifest.json"; then
        should_release="false"
        skip_reason="manifest and R2 latest/* match latest release $latest_tag"
      else
        release_tag_fallback="$latest_tag"
        repair_r2_only="true"
        skip_reason="latest release $latest_tag matches upstream, but R2 latest/* is stale or incomplete; repairing"
      fi
    elif downgrade_detail="$(manifest_downgrades_from "$tmp_dir/release-manifest.json" "$manifest_path")"; then
      should_release="false"
      downgraded="true"
      skip_reason="probed manifest downgrades $downgrade_detail vs latest release $latest_tag ($previous_version); skipping"
    fi
  fi
  if [[ -n "$r2_public_base_url" ]]; then
    r2_live_status=""
    if ! r2_live_status="$(curl -sSL --retry 3 --retry-delay 1 --connect-timeout 10 --max-time 30 -o "$tmp_dir/r2-live-check.json" -w '%{http_code}' "$r2_public_base_url/latest/manifest?probe=$$")"; then
      echo "Failed querying R2 live manifest ($r2_public_base_url/latest/manifest); failing closed to prevent accidental downgrade." >&2
      exit 1
    fi
    if [[ "$r2_live_status" == "200" ]]; then
      if ! r2_live_version="$(jq -er '.version | select(type == "string" and length > 0)' "$tmp_dir/r2-live-check.json" 2>/dev/null)"; then
        echo "Malformed R2 live manifest at $r2_public_base_url/latest/manifest (missing string .version); failing closed." >&2
        exit 1
      fi
      validate_version_token "R2 live version" "$r2_live_version"
      r2_downgrade_detail=""
      if [[ "$downgraded" != "true" ]] && r2_downgrade_detail="$(manifest_downgrades_from "$tmp_dir/r2-live-check.json" "$manifest_path")"; then
        should_release="false"
        repair_r2_only="false"
        downgraded="true"
        skip_reason="probed manifest downgrades $r2_downgrade_detail vs R2 live manifest ($r2_live_version); skipping"
      fi
    elif [[ "$r2_live_status" != "404" ]]; then
      echo "Unexpected HTTP $r2_live_status querying R2 live manifest ($r2_public_base_url/latest/manifest); failing closed." >&2
      exit 1
    fi
  fi
fi

if [[ "$should_release" == "true" && "$force_release" != "true" && -z "$release_tag_input" && -z "$release_tag_fallback" ]]; then
  predicted_tag="claude-app-v$(sanitize_tag_part "$version")"
  if gh_release_exists "$predicted_tag"; then
    mkdir -p "$tmp_dir/existing-tag"
    if ! gh release download "$predicted_tag" -p release-manifest.json -D "$tmp_dir/existing-tag" --clobber >/dev/null 2>&1; then
      echo "Failed to download release-manifest.json from existing release $predicted_tag; failing closed." >&2
      exit 1
    fi
    if manifests_match "$manifest_path" "$tmp_dir/existing-tag/release-manifest.json"; then
      if public_mirror_latest_matches "$manifest_path" "$predicted_tag" "$tmp_dir/existing-tag/release-manifest.json"; then
        should_release="false"
        skip_reason="release tag $predicted_tag already matches current sources and R2 latest/*"
      else
        release_tag_fallback="$predicted_tag"
        repair_r2_only="true"
        skip_reason="release tag $predicted_tag matches current sources, but R2 latest/* needs repair"
      fi
    else
      # Non-macOS platform updated or upstream rebuilt while macOS version stayed constant:
      # derive a deterministic content-addressed revision tag instead of silently skipping!
      rev_suffix="$(manifest_fingerprint_sha256 "$manifest_path" | cut -c1-8)"
      revised_tag="${predicted_tag}-${rev_suffix}"
      if gh_release_exists "$revised_tag"; then
        mkdir -p "$tmp_dir/existing-revised-tag"
        if ! gh release download "$revised_tag" -p release-manifest.json -D "$tmp_dir/existing-revised-tag" --clobber >/dev/null 2>&1; then
          echo "Failed to download release-manifest.json from existing release $revised_tag; failing closed." >&2
          exit 1
        fi
        if ! manifests_match "$manifest_path" "$tmp_dir/existing-revised-tag/release-manifest.json"; then
          echo "Existing revision release $revised_tag does not match probed manifest; failing closed." >&2
          exit 1
        fi
        if public_mirror_latest_matches "$manifest_path" "$revised_tag" "$tmp_dir/existing-revised-tag/release-manifest.json"; then
          should_release="false"
          skip_reason="revision tag $revised_tag already exists and R2 latest/* matches"
        else
          release_tag_fallback="$revised_tag"
          repair_r2_only="true"
          skip_reason="revision tag $revised_tag exists, repairing R2 latest/*"
        fi
      else
        release_tag_fallback="$revised_tag"
      fi
    fi
  fi
fi

if [[ -n "$release_tag_input" ]]; then
  release_tag="$release_tag_input"
  if gh_release_exists "$release_tag_input"; then
    mkdir -p "$tmp_dir/input-tag"
    if ! gh release download "$release_tag_input" -p release-manifest.json -D "$tmp_dir/input-tag" --clobber >/dev/null 2>&1; then
      echo "Failed to download release-manifest.json from existing release $release_tag_input; failing closed." >&2
      exit 1
    fi
    if ! manifests_match "$manifest_path" "$tmp_dir/input-tag/release-manifest.json"; then
      echo "Release tag '$release_tag_input' already exists with different sources; refusing to overwrite immutable release." >&2
      exit 1
    fi
    if [[ "$downgraded" == "true" ]]; then
      should_release="false"
      repair_r2_only="false"
    elif [[ "$force_release" != "true" ]] &&
       public_mirror_latest_matches "$manifest_path" "$release_tag_input" "$tmp_dir/input-tag/release-manifest.json"; then
      should_release="false"
      repair_r2_only="false"
      skip_reason="explicit release tag $release_tag_input already matches current sources and R2 latest/*"
    else
      should_release="true"
      repair_r2_only="true"
      skip_reason="explicit release tag $release_tag_input already exists and matches sources; repairing R2 latest/*"
    fi
  elif [[ "$downgraded" == "true" ]]; then
    should_release="false"
    repair_r2_only="false"
  else
    repair_r2_only="false"
  fi
elif [[ "$force_release" == "true" ]]; then
  release_tag="claude-app-force-$(date -u +'%Y%m%d-%H%M%S')"
  repair_r2_only="false"
elif [[ -n "$release_tag_fallback" ]]; then
  release_tag="$release_tag_fallback"
else
  release_tag=""
fi

if [[ -n "$release_tag" ]]; then
  validate_release_tag "$release_tag"
fi

version_summary="version=$version; mac=$(jq -r '.sources.macos.universal.contentLength' "$manifest_path")B; win-x64=$(jq -r '.sources.windows.x64.contentLength' "$manifest_path")B; win-arm64=$(jq -r '.sources.windows.arm64.contentLength' "$manifest_path")B; linux-x64=$(jq -r '.sources.linux.x64.contentLength' "$manifest_path")B; linux-arm64=$(jq -r '.sources.linux.arm64.contentLength' "$manifest_path")B"

github_output_value() {
  local name="$1" value="$2"
  local delimiter="__claude_output_${name}_$$__"
  printf '%s<<%s\n%s\n%s\n' "$name" "$delimiter" "$value" "$delimiter"
}

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    github_output_value "should_release" "$should_release"
    github_output_value "repair_r2_only" "$repair_r2_only"
    github_output_value "release_tag" "$release_tag"
    github_output_value "latest_tag" "$latest_tag"
    github_output_value "skip_reason" "$skip_reason"
    github_output_value "version_summary" "$version_summary"
    github_output_value "manifest" "$(cat "$manifest_path")"
  } >> "$GITHUB_OUTPUT"
fi

echo "should_release=$should_release"
echo "repair_r2_only=$repair_r2_only"
echo "release_tag=$release_tag"
echo "latest_tag=$latest_tag"
echo "skip_reason=$skip_reason"
echo "version_summary=$version_summary"
