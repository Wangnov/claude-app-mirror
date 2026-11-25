#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

mkdir -p "$tmp_dir/srv" "$tmp_dir/mock-bin"
printf 'mac-universal-payload' > "$tmp_dir/srv/Claude-mac.dmg"
printf 'win-x64-payload'       > "$tmp_dir/srv/Claude-win-x64.msix"
printf 'win-arm64-payload'     > "$tmp_dir/srv/Claude-win-arm64.msix"
printf 'linux-x64-payload'     > "$tmp_dir/srv/Claude-linux-x64.deb"
printf 'linux-arm64-payload'   > "$tmp_dir/srv/Claude-linux-arm64.deb"
printf 'BAD-x64-payload'       > "$tmp_dir/srv/corrupt-win-x64.msix"

md5_b64() {
  openssl dgst -md5 -binary "$1" | openssl base64 | tr -d '\r\n'
}

mac_md5="$(md5_b64 "$tmp_dir/srv/Claude-mac.dmg")"
win_x64_md5="$(md5_b64 "$tmp_dir/srv/Claude-win-x64.msix")"
win_arm64_md5="$(md5_b64 "$tmp_dir/srv/Claude-win-arm64.msix")"
linux_x64_md5="$(md5_b64 "$tmp_dir/srv/Claude-linux-x64.deb")"

port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
flaky_counter="$tmp_dir/flaky-count"
mode_file="$tmp_dir/server-mode"
printf '0' > "$flaky_counter"
printf 'normal' > "$mode_file"

# Local HTTP mock serving:
# - /api/desktop/<platform>/<arch>/<fmt>/latest/redirect -> 307 to /hop/...
# - /hop/<ver>/<file> -> 302 (with decoy x-goog-hash & Content-Length: 0) to /gcs/<ver>/<file>
# - /gcs/<ver>/<file> -> 200 with multi-line or comma-merged x-goog-hash headers
python3 - "$tmp_dir/srv" "$port" "$flaky_counter" "$mode_file" <<'PY' &
import base64
import hashlib
import http.server
import os
import sys

root, port, counter_file, mode_file = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]

FILES = {
    ("darwin", "universal", "dmg"): "Claude-mac.dmg",
    ("win32", "x64", "msix"): "Claude-win-x64.msix",
    ("win32", "arm64", "msix"): "Claude-win-arm64.msix",
    ("linux", "x64", "deb"): "Claude-linux-x64.deb",
    ("linux", "arm64", "deb"): "Claude-linux-arm64.deb",
}

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _mode(self):
        return open(mode_file).read().strip()

    def do_HEAD(self):
        self._handle(send_body=False)

    def do_GET(self):
        self._handle(send_body=True)

    def _handle(self, send_body):
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        mode = self._mode()

        # /api/desktop/<platform>/<arch>/<fmt>/latest/redirect
        if len(parts) == 7 and parts[:2] == ["api", "desktop"] and parts[5:] == ["latest", "redirect"]:
            fname = FILES[(parts[2], parts[3], parts[4])]
            self.send_response(307)
            self.send_header("Location", f"http://127.0.0.1:{port}/hop/6.28899.6/{fname}")
            self.end_headers()
            return

        # Intermediate redirect hop with decoy Content-Length: 0 and decoy x-goog-hash
        if len(parts) == 3 and parts[0] == "hop":
            _, ver, fname = parts
            self.send_response(302)
            self.send_header("Content-Length", "0")
            self.send_header("x-goog-hash", "md5=WRONGHOPMD5==")
            self.send_header("Location", f"http://127.0.0.1:{port}/gcs/{ver}/{fname}")
            self.end_headers()
            return

        # Final GCS object endpoint
        if len(parts) == 3 and parts[0] == "gcs":
            _, ver, fname = parts
            actual_file = fname
            if fname == "Claude-win-x64.msix" and send_body:
                if mode == "flaky":
                    count = int(open(counter_file).read().strip() or "0") + 1
                    open(counter_file, "w").write(str(count))
                    if count == 1:
                        actual_file = "corrupt-win-x64.msix"
                elif mode == "corrupt":
                    actual_file = "corrupt-win-x64.msix"

            data = open(os.path.join(root, actual_file), "rb").read()
            canonical_data = open(os.path.join(root, fname), "rb").read()
            md5_val = base64.b64encode(hashlib.md5(canonical_data).digest()).decode("ascii")

            self.send_response(200)
            if mode == "zero-len" and fname == "Claude-mac.dmg":
                self.send_header("Content-Length", "0")
            else:
                self.send_header("Content-Length", str(len(data)))

            # Exercise all three x-goog-hash header shapes across the 5 artifacts:
            if fname in ("Claude-mac.dmg", "Claude-win-x64.msix"):
                # Multi-line separate x-goog-hash headers
                self.send_header("x-goog-stored-content-encoding", "identity")
                self.send_header("x-goog-hash", "crc32c=JaqN0A==")
                self.send_header("X-Goog-Hash", f"md5={md5_val}")
            elif fname in ("Claude-win-arm64.msix", "Claude-linux-x64.deb"):
                # Single-line comma-merged mixed-case X-Goog-Hash
                self.send_header("X-Goog-Hash", f"crc32c=0Z1W8A==, MD5={md5_val}")
            else:
                # Non-identity stored encoding on linux-arm64 -> probe must omit md5
                self.send_header("x-goog-stored-content-encoding", "gzip")
                self.send_header("x-goog-hash", f"md5={md5_val}")

            self.send_header("ETag", '"test-etag"')
            self.end_headers()
            if send_body:
                self.wfile.write(data)
            return

        if parts and parts[0] == "r2-503":
            self.send_response(503)
            self.end_headers()
            return

        self.send_response(404)
        self.end_headers()

http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
PY
server_pid="$!"

for _ in {1..30}; do
  if curl -fsSI "http://127.0.0.1:$port/gcs/6.28899.6/Claude-mac.dmg" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

# Create mock `gh` CLI returning a previous release manifest WITHOUT .md5 fields
# to assert R2 invariant: adding .md5 must NOT trigger duplicate should_release=true.
cat > "$tmp_dir/prev-release-manifest.json" <<JSON
{
  "schemaVersion": 2,
  "version": "6.28899.6",
  "sources": {
    "macos": { "universal": { "url": "http://127.0.0.1:$port/hop/6.28899.6/Claude-mac.dmg", "contentLength": 21 } },
    "windows": {
      "x64": { "url": "http://127.0.0.1:$port/hop/6.28899.6/Claude-win-x64.msix", "contentLength": 15 },
      "arm64": { "url": "http://127.0.0.1:$port/hop/6.28899.6/Claude-win-arm64.msix", "contentLength": 17 }
    },
    "linux": {
      "x64": { "url": "http://127.0.0.1:$port/hop/6.28899.6/Claude-linux-x64.deb", "contentLength": 17 },
      "arm64": { "url": "http://127.0.0.1:$port/hop/6.28899.6/Claude-linux-arm64.deb", "contentLength": 19 }
    }
  }
}
JSON

cat > "$tmp_dir/mock-bin/gh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "release" && "\${2:-}" == "list" ]]; then
  printf 'claude-app-v6.28899.6\n'
  exit 0
fi
if [[ "\${1:-}" == "release" && "\${2:-}" == "view" && "\${3:-}" == "--json" ]]; then
  printf '{"tagName":"claude-app-v6.28899.6"}\n'
  exit 0
fi
if [[ "\${1:-}" == "release" && "\${2:-}" == "download" ]]; then
  dest="."
  while [[ \$# -gt 0 ]]; do
    if [[ "\$1" == "-D" ]]; then
      dest="\$2"
      shift 2
    else
      shift
    fi
  done
  cp "$tmp_dir/prev-release-manifest.json" "\$dest/release-manifest.json"
  exit 0
fi
exit 1
EOF
chmod +x "$tmp_dir/mock-bin/gh"

# --- Case 1: End-to-end probe-release.sh parses multi-hop/multi-format GCS MD5 and preserves manifest_key ---
probe_out="$(
  PATH="$tmp_dir/mock-bin:$PATH" \
  UPDATE_API_BASE="http://127.0.0.1:$port" \
  MANIFEST_PATH="$tmp_dir/probed-manifest.json" \
    bash "$repo_root/scripts/probe-release.sh"
)"
grep -Fxq "should_release=false" <<<"$probe_out"
[[ "$(jq -r '.sources.macos.universal.md5' "$tmp_dir/probed-manifest.json")" == "$mac_md5" ]]
[[ "$(jq -r '.sources.windows.x64.md5' "$tmp_dir/probed-manifest.json")" == "$win_x64_md5" ]]
[[ "$(jq -r '.sources.windows.arm64.md5' "$tmp_dir/probed-manifest.json")" == "$win_arm64_md5" ]]
[[ "$(jq -r '.sources.linux.x64.md5' "$tmp_dir/probed-manifest.json")" == "$linux_x64_md5" ]]
[[ -z "$(jq -r '.sources.linux.arm64.md5' "$tmp_dir/probed-manifest.json")" ]]

# --- Case 2: probe-release.sh fails closed when upstream Content-Length is 0 ---
printf 'zero-len' > "$mode_file"
if PATH="$tmp_dir/mock-bin:$PATH" \
   UPDATE_API_BASE="http://127.0.0.1:$port" \
   MANIFEST_PATH="$tmp_dir/probed-zero.json" \
     bash "$repo_root/scripts/probe-release.sh" 2>/dev/null; then
  echo "Expected probe-release.sh to fail closed on Content-Length: 0" >&2
  exit 1
fi

# --- Case 3: download-artifacts.sh catches transient same-size MD5 corruption and succeeds on retry ---
printf 'flaky' > "$mode_file"
printf '0' > "$flaky_counter"
DOWNLOAD_MAX_ATTEMPTS=2 DOWNLOAD_RETRY_DELAY_SECONDS=0 \
  bash "$repo_root/scripts/download-artifacts.sh" "$tmp_dir/out-ok" "$tmp_dir/probed-manifest.json"
[[ "$(cat "$flaky_counter")" == "2" ]]
[[ "$(cat "$tmp_dir/out-ok/Claude-win-x64.msix")" == "win-x64-payload" ]]

# --- Case 4: download-artifacts.sh fails closed on 0 or null contentLength in manifest ---
printf 'normal' > "$mode_file"
for bad_len in 0 null; do
  jq ".sources.windows.x64.contentLength = $bad_len" "$tmp_dir/probed-manifest.json" > "$tmp_dir/manifest-badlen.json"
  if DOWNLOAD_MAX_ATTEMPTS=1 DOWNLOAD_RETRY_DELAY_SECONDS=0 \
     bash "$repo_root/scripts/download-artifacts.sh" "$tmp_dir/out-badlen-$bad_len" "$tmp_dir/manifest-badlen.json" 2>/dev/null; then
    echo "Expected contentLength=$bad_len to fail closed in download-artifacts.sh" >&2
    exit 1
  fi
done

# --- Case 5: Persistent same-size MD5 mismatch fails and leaves no corrupt or .part files behind ---
printf 'corrupt' > "$mode_file"
if DOWNLOAD_MAX_ATTEMPTS=2 DOWNLOAD_RETRY_DELAY_SECONDS=0 \
   bash "$repo_root/scripts/download-artifacts.sh" "$tmp_dir/out-corrupt" "$tmp_dir/probed-manifest.json" 2>/dev/null; then
  echo "Expected persistent MD5 mismatch to fail download-artifacts.sh" >&2
  exit 1
fi
[[ ! -f "$tmp_dir/out-corrupt/Claude-win-x64.msix" ]]
[[ ! -f "$tmp_dir/out-corrupt/Claude-win-x64.msix.part" ]]

# --- Case 6: Staggered non-macOS update when base tag already exists emits revision tag instead of skipping ---
printf 'normal' > "$mode_file"
jq '.sources.windows.x64.url = "http://127.0.0.1:1/old-win-x64.msix"' "$tmp_dir/prev-release-manifest.json" > "$tmp_dir/staggered-prev.json"
cat > "$tmp_dir/mock-bin/gh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "release" && "\${2:-}" == "list" ]]; then
  printf 'claude-app-v6.28899.6\n'
  exit 0
fi
if [[ "\${1:-}" == "release" && "\${2:-}" == "view" ]]; then
  if [[ "\${GH_VIEW_503:-}" == "true" ]]; then
    echo "HTTP 503: upstream not found" >&2
    exit 1
  fi
  if [[ "\${3:-}" == "--json" || "\${3:-}" == "claude-app-v6.28899.6" ]]; then
    printf '{"tagName":"claude-app-v6.28899.6"}\n'
    exit 0
  fi
  echo "release not found" >&2
  exit 1
fi
if [[ "\${1:-}" == "release" && "\${2:-}" == "download" ]]; then
  dest="."
  while [[ \$# -gt 0 ]]; do
    if [[ "\$1" == "-D" ]]; then dest="\$2"; shift 2; else shift; fi
  done
  cp "$tmp_dir/staggered-prev.json" "\$dest/release-manifest.json"
  exit 0
fi
exit 1
EOF
chmod +x "$tmp_dir/mock-bin/gh"

staggered_out="$(
  PATH="$tmp_dir/mock-bin:$PATH" \
  UPDATE_API_BASE="http://127.0.0.1:$port" \
  MANIFEST_PATH="$tmp_dir/probed-staggered.json" \
    bash "$repo_root/scripts/probe-release.sh"
)"
grep -Fxq "should_release=true" <<<"$staggered_out"
grep -Fxq "repair_r2_only=false" <<<"$staggered_out"
grep -Eq '^release_tag=claude-app-v6\.28899\.6-[0-9a-f]{8}$' <<<"$staggered_out"

# --- Case 7: R2 latest/* drift triggers repair_r2_only=true using existing latest_tag when GitHub Release already matches ---
cp "$tmp_dir/probed-manifest.json" "$tmp_dir/staggered-prev.json"
repair_out="$(
  PATH="$tmp_dir/mock-bin:$PATH" \
  UPDATE_API_BASE="http://127.0.0.1:$port" \
  R2_PUBLIC_BASE_URL="http://127.0.0.1:$port/missing-r2" \
  MANIFEST_PATH="$tmp_dir/probed-repair.json" \
    bash "$repo_root/scripts/probe-release.sh"
)"
grep -Fxq "should_release=true" <<<"$repair_out"
grep -Fxq "repair_r2_only=true" <<<"$repair_out"
grep -Fxq "release_tag=claude-app-v6.28899.6" <<<"$repair_out"

# --- Case 8: Final release 6.28899.6 after 6.28899.6-rc.1 is NOT treated as a downgrade ---
jq '.version = "6.28899.6-rc.1" | .sources.windows.x64.url = "http://127.0.0.1:1/rc.msix"' \
  "$tmp_dir/probed-manifest.json" > "$tmp_dir/staggered-prev.json"
rc_upgrade_out="$(
  PATH="$tmp_dir/mock-bin:$PATH" \
  UPDATE_API_BASE="http://127.0.0.1:$port" \
  MANIFEST_PATH="$tmp_dir/probed-rc-upgrade.json" \
    bash "$repo_root/scripts/probe-release.sh"
)"
grep -Fxq "should_release=true" <<<"$rc_upgrade_out"
grep -Fxq "repair_r2_only=false" <<<"$rc_upgrade_out"

# --- Case 9: Numeric prerelease comparison (rc.10 > rc.2) and fail-closed on non-404 gh release view ---
jq '.version = "6.28899.6-rc.10" | .sources.windows.x64.url = "http://127.0.0.1:1/rc10.msix"' \
  "$tmp_dir/probed-manifest.json" > "$tmp_dir/staggered-prev.json"
# Probed version is 6.28899.6 (final > rc.10 -> should_release=true); also test gh_release_exists 503 fail-closed!
if PATH="$tmp_dir/mock-bin:$PATH" \
   GH_VIEW_503="true" \
   UPDATE_API_BASE="http://127.0.0.1:$port" \
   MANIFEST_PATH="$tmp_dir/probed-503.json" \
     bash "$repo_root/scripts/probe-release.sh" 2>/dev/null; then
  echo "Expected non-404 gh release view error (HTTP 503) to fail closed" >&2
  exit 1
fi

# --- Case 10: Manual RELEASE_TAG pointing to an older existing tag with FORCE_RELEASE=false MUST NOT downgrade R2 ---
jq '.version = "7.0.0" | .sources.windows.x64.url = "http://127.0.0.1:1/Claude-win-x64-7.0.0.msix"' \
  "$tmp_dir/probed-manifest.json" > "$tmp_dir/latest-7.json"
cp "$tmp_dir/probed-manifest.json" "$tmp_dir/older-6.json"
cat > "$tmp_dir/mock-bin/gh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "release" && "\${2:-}" == "list" ]]; then
  # Simulate a later-created backfill release (6.0.0) hiding Latest (7.0.0) in gh release list!
  printf 'claude-app-v6.0.0\n'
  exit 0
fi
if [[ "\${1:-}" == "release" && "\${2:-}" == "view" ]]; then
  if [[ "\${3:-}" == "--json" ]]; then
    echo "Notice: checking /releases/latest on GitHub API" >&2
    printf '{"tagName":"claude-app-v7.0.0"}\n'
    exit 0
  fi
  if [[ "\${3:-}" == "claude-app-v7.0.0" || "\${3:-}" == "claude-app-v6.28899.6" || "\${3:-}" == "claude-app-v6.0.0" ]]; then
    printf '{"tagName":"%s"}\n' "\${3}"
    exit 0
  fi
  echo "release not found" >&2
  exit 1
fi
if [[ "\${1:-}" == "release" && "\${2:-}" == "download" ]]; then
  tag="\${3:-}"
  dest="."
  while [[ \$# -gt 0 ]]; do
    if [[ "\$1" == "-D" ]]; then dest="\$2"; shift 2; else shift; fi
  done
  if [[ "\$tag" == "claude-app-v7.0.0" ]]; then
    cp "$tmp_dir/latest-7.json" "\$dest/release-manifest.json"
  else
    cp "$tmp_dir/older-6.json" "\$dest/release-manifest.json"
  fi
  exit 0
fi
exit 1
EOF
chmod +x "$tmp_dir/mock-bin/gh"

downgrade_manual_out="$(
  PATH="$tmp_dir/mock-bin:$PATH" \
  UPDATE_API_BASE="http://127.0.0.1:$port" \
  FORCE_RELEASE="false" \
  RELEASE_TAG="claude-app-v6.28899.6" \
  R2_PUBLIC_BASE_URL="http://127.0.0.1:$port/missing-r2" \
  MANIFEST_PATH="$tmp_dir/probed-downgrade-manual.json" \
    bash "$repo_root/scripts/probe-release.sh"
)"
grep -Fxq "should_release=false" <<<"$downgrade_manual_out"
grep -Fxq "repair_r2_only=false" <<<"$downgrade_manual_out"

# --- Case 11: Arbitrary-precision >53-bit numeric version comparison (6.9007199254740993.0 > 6.9007199254740992.0) ---
jq '.version = "6.9007199254740993.0"' "$tmp_dir/probed-manifest.json" > "$tmp_dir/latest-7.json"
# Probed version is 6.28899.6 < 6.9007199254740993.0; also directly test 9007199254740993 vs 9007199254740992 via sourced function!
(
  # Extract version_gt function from probe-release.sh and verify >53-bit integer precision + 2-component float trap (7.10 > 7.1) on local awk
  eval "$(sed -n '/^version_gt()/,/^}/p' "$repo_root/scripts/probe-release.sh")"
  version_gt "6.9007199254740993.0" "6.9007199254740992.0"
  version_gt "7.10" "7.1"
  if version_gt "7.1" "7.10"; then exit 1; fi
  if version_gt "7.0" "7"; then exit 1; fi
  if version_gt "6.9007199254740992.0" "6.9007199254740993.0"; then exit 1; fi
  if version_gt "6.09007199254740993.0" "6.9007199254740993.0"; then exit 1; fi
)

# --- Case 12: R2 live-version lookup HTTP 503 fails closed instead of permitting accidental R2 downgrade ---
cp "$tmp_dir/older-6.json" "$tmp_dir/latest-7.json"
if PATH="$tmp_dir/mock-bin:$PATH" \
   UPDATE_API_BASE="http://127.0.0.1:$port" \
   FORCE_RELEASE="false" \
   RELEASE_TAG="claude-app-v6.28899.6" \
   R2_PUBLIC_BASE_URL="http://127.0.0.1:$port/r2-503" \
   MANIFEST_PATH="$tmp_dir/probed-r2-503.json" \
     bash "$repo_root/scripts/probe-release.sh" 2>/dev/null; then
  echo "Expected HTTP 503 on R2 live manifest lookup to fail closed" >&2
  exit 1
fi

# --- Case 13: Per-platform downgrade guard (macOS stays 6.28899.6 while Windows x64 on GitHub Latest is 6.28900.0) ---
jq '.sources.windows.x64.version = "6.28900.0" | .sources.windows.x64.url = "http://127.0.0.1:1/Claude-win-x64-6.28900.0.msix"' \
  "$tmp_dir/probed-manifest.json" > "$tmp_dir/latest-7.json"
win_downgrade_out="$(
  PATH="$tmp_dir/mock-bin:$PATH" \
  UPDATE_API_BASE="http://127.0.0.1:$port" \
  FORCE_RELEASE="false" \
  RELEASE_TAG="claude-app-v6.28899.6" \
  R2_PUBLIC_BASE_URL="http://127.0.0.1:$port/missing-r2" \
  MANIFEST_PATH="$tmp_dir/probed-win-downgrade.json" \
    bash "$repo_root/scripts/probe-release.sh"
)"
grep -Fxq "should_release=false" <<<"$win_downgrade_out"
grep -Fxq "repair_r2_only=false" <<<"$win_downgrade_out"

echo "probe GCS header + download-artifacts verification fixture PASS"
