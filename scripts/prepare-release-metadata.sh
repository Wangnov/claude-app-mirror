#!/usr/bin/env bash
set -euo pipefail

# Augment the probe manifest with SHA-256 sums, write SHA256SUMS.txt and bilingual
# release notes, and emit the release tag/title.
#
# Usage: prepare-release-metadata.sh <probe-manifest> <artifacts-dir> <r2-public-base-url> [release-tag-override]

probe_manifest="${1:-probe-manifest.json}"
artifacts_dir="${2:-dist}"
r2_public_base_url="${3:-https://claudeapp.agentsmirror.com}"
release_tag_override="${4:-}"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require jq
require sha256sum
require find

sanitize_tag_part() {
  tr -cs 'A-Za-z0-9._-' '-' <<<"$1" | sed -E 's/^-+//; s/-+$//'
}

if [[ ! -f "$probe_manifest" ]]; then
  echo "Missing probe manifest: $probe_manifest" >&2
  exit 1
fi

version="$(jq -r '.version // empty' "$probe_manifest")"
if [[ -z "$version" ]]; then
  echo "Probe manifest is missing .version" >&2
  exit 1
fi

mac_file="$artifacts_dir/Claude-mac-universal.dmg"
win_x64_file="$artifacts_dir/Claude-win-x64.msix"
win_arm64_file="$artifacts_dir/Claude-win-arm64.msix"

for file in "$mac_file" "$win_x64_file" "$win_arm64_file"; do
  if [[ ! -f "$file" ]]; then
    echo "Missing artifact: $file" >&2
    exit 1
  fi
done

sha_of() {
  sha256sum "$1" | awk '{ print $1 }'
}

mac_sha="$(sha_of "$mac_file")"
win_x64_sha="$(sha_of "$win_x64_file")"
win_arm64_sha="$(sha_of "$win_arm64_file")"

mac_version="$(jq -r '.sources.macos.universal.version' "$probe_manifest")"
win_x64_version="$(jq -r '.sources.windows.x64.version' "$probe_manifest")"
win_arm64_version="$(jq -r '.sources.windows.arm64.version' "$probe_manifest")"

if [[ -n "$release_tag_override" ]]; then
  tag="$release_tag_override"
else
  tag="claude-app-v$(sanitize_tag_part "$version")"
fi
title="Claude App Mirror $version"

jq \
  --arg macSha "$mac_sha" \
  --arg winX64Sha "$win_x64_sha" \
  --arg winArm64Sha "$win_arm64_sha" \
  '
  .schemaVersion = 2
  | .sources.macos.universal.sha256 = $macSha
  | .sources.macos.universal.assetName = "Claude-mac-universal.dmg"
  | .sources.windows.x64.sha256 = $winX64Sha
  | .sources.windows.x64.assetName = "Claude-win-x64.msix"
  | .sources.windows.arm64.sha256 = $winArm64Sha
  | .sources.windows.arm64.assetName = "Claude-win-arm64.msix"
  ' "$probe_manifest" > release-manifest.json

{
  while IFS= read -r -d '' file; do
    printf '%s  %s\n' "$(sha_of "$file")" "$(basename "$file")"
  done < <(find "$artifacts_dir" -type f \( -name '*.dmg' -o -name '*.msix' \) -print0 | sort -z)
  printf '%s  %s\n' "$(sha_of release-manifest.json)" "release-manifest.json"
} > SHA256SUMS.txt

{
  echo "# Claude 桌面端安装包镜像更新"
  echo
  echo "本次 Release 同步了官方 Claude 桌面应用的安装包，方便在 GitHub Releases 中下载当前版本对应的安装包。"
  echo
  echo "## 下载"
  echo
  echo "- macOS（Apple Silicon + Intel 通用包）: \`Claude-mac-universal.dmg\`"
  echo "- Windows x64: \`Claude-win-x64.msix\`"
  echo "- Windows arm64: \`Claude-win-arm64.msix\`"
  echo
  echo "## 版本信息"
  echo
  echo "- macOS universal: \`${mac_version}\`"
  echo "- Windows x64: \`${win_x64_version}\`"
  echo "- Windows arm64: \`${win_arm64_version}\`"
  echo
  echo "<!-- latest-links-cn:start -->"
  echo "## 最新版快速下载"
  echo
  echo "- macOS: ${r2_public_base_url}/latest/mac"
  echo "- Windows x64: ${r2_public_base_url}/latest/win-x64"
  echo "- Windows arm64: ${r2_public_base_url}/latest/win-arm64"
  echo "- 校验和: ${r2_public_base_url}/latest/checksums"
  echo "- Manifest: ${r2_public_base_url}/latest/manifest"
  echo
  echo "R2 短链是面向国内网络准备的下载镜像，只保留当前最新版。需要旧版本时，请到本仓库 Releases 按 tag 查找历史资产。"
  echo "<!-- latest-links-cn:end -->"
  echo
  echo "## 安装说明"
  echo
  echo "- macOS：打开 \`.dmg\`，把 Claude 拖进“应用程序”即可。"
  echo "- Windows：双击 \`.msix\`，由“应用安装程序”完成安装；或用 PowerShell \`Add-AppxPackage Claude-win-x64.msix\`。MSIX 为已签名包，消费版 Windows 10/11 默认允许安装；若被组策略限制，需要管理员放行已签名应用的侧载。"
  echo
  echo "> 我们镜像的是 **自包含、可离线安装** 的 \`.dmg\` 与 \`.msix\`。官网 Windows 的 \`ClaudeSetup.exe\`（约 7MB）只是一个在线引导器，安装时仍会回 \`downloads.claude.ai\`（Google Cloud Storage）下载真正的 MSIX，因此不在镜像范围内。"
  echo
  echo "## 校验"
  echo
  echo "建议下载后使用随附的 \`SHA256SUMS.txt\` 校验文件完整性。"
  echo
  echo "## 来源说明"
  echo
  echo "本项目只镜像官方安装包，不修改、不重打包、不破解安装器。上游指纹（版本、URL、内容哈希、大小）记录在随附的 \`release-manifest.json\` 中。Claude 官方没有 Linux 桌面客户端，故本项目不包含 Linux 产物。"
  echo
  echo "---"
  echo
  echo "# Claude desktop installer mirror update"
  echo
  echo "This release mirrors the official Claude desktop app installers and makes the matching packages available as assets on this GitHub Release."
  echo
  echo "## Downloads"
  echo
  echo "- macOS (universal, Apple Silicon + Intel): \`Claude-mac-universal.dmg\`"
  echo "- Windows x64: \`Claude-win-x64.msix\`"
  echo "- Windows arm64: \`Claude-win-arm64.msix\`"
  echo
  echo "## Version details"
  echo
  echo "- macOS universal: \`${mac_version}\`"
  echo "- Windows x64: \`${win_x64_version}\`"
  echo "- Windows arm64: \`${win_arm64_version}\`"
  echo
  echo "<!-- latest-links-en:start -->"
  echo "## Latest quick downloads"
  echo
  echo "- macOS: ${r2_public_base_url}/latest/mac"
  echo "- Windows x64: ${r2_public_base_url}/latest/win-x64"
  echo "- Windows arm64: ${r2_public_base_url}/latest/win-arm64"
  echo "- Checksums: ${r2_public_base_url}/latest/checksums"
  echo "- Manifest: ${r2_public_base_url}/latest/manifest"
  echo
  echo "These links always point to the newest mirrored version. For older versions, use this repository's Releases and download assets from the matching tag."
  echo "<!-- latest-links-en:end -->"
  echo
  echo "## Install"
  echo
  echo "- macOS: open the \`.dmg\` and drag Claude into Applications."
  echo "- Windows: double-click the \`.msix\` (App Installer), or run \`Add-AppxPackage Claude-win-x64.msix\`. The MSIX is signed; consumer Windows 10/11 allows it by default. Locked-down machines may need an admin to allow signed-app sideloading."
  echo
  echo "> We mirror the **self-contained, offline-installable** \`.dmg\` and \`.msix\`. The official Windows \`ClaudeSetup.exe\` (~7MB) is only an online bootstrapper that re-downloads the real MSIX from \`downloads.claude.ai\` (Google Cloud Storage) at install time, so it is intentionally not mirrored."
  echo
  echo "## Verification"
  echo
  echo "We recommend verifying downloaded files with the attached \`SHA256SUMS.txt\`."
  echo
  echo "## Source notes"
  echo
  echo "This project only mirrors official installer packages. It does not modify, repackage, or bypass installer authorization. The full upstream fingerprints are in the attached \`release-manifest.json\`. Anthropic ships no official Linux desktop client, so no Linux artifact is included."
} > release-notes.md

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "tag=$tag"
    echo "title=$title"
  } >> "$GITHUB_OUTPUT"
fi

echo "tag=$tag"
echo "title=$title"
