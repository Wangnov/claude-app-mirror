<h1 align="center">claude-app-mirror</h1>

<p align="center">
  Mirror the official Claude desktop app installers into GitHub Releases.
</p>

<p align="center">
  <a href="https://github.com/Wangnov/claude-app-mirror/releases/latest"><img src="https://img.shields.io/github/release-date/Wangnov/claude-app-mirror?label=updated&logo=github" alt="Latest update time"></a>
  <a href="https://github.com/Wangnov/claude-app-mirror/actions/workflows/mirror.yml"><img src="https://img.shields.io/github/actions/workflow/status/Wangnov/claude-app-mirror/mirror.yml?branch=main&label=mirror&logo=githubactions" alt="Mirror workflow"></a>
  <a href="https://github.com/Wangnov/claude-app-mirror/actions/workflows/mirror.yml"><img src="https://img.shields.io/badge/polling-every%2015%20minutes-2ea44f" alt="15 minute polling"></a>
  <a href="https://github.com/Wangnov/claude-app-mirror/releases/latest"><img src="https://img.shields.io/badge/macOS-universal-000000?logo=apple" alt="macOS universal"></a>
  <a href="https://github.com/Wangnov/claude-app-mirror/releases/latest"><img src="https://img.shields.io/badge/Windows-x64%20%7C%20arm64%20MSIX-0078d4?logo=windows" alt="Windows x64 and arm64 MSIX"></a>
</p>

<p align="center">
  GitHub Release · Cloudflare R2 short links · macOS DMG · Windows MSIX · checksums · release manifest
</p>

<p align="center">
  <a href="#readme-cn">中文</a> · <a href="#readme-en">English</a>
</p>

---

<a id="readme-cn"></a>

# 中文

有时候你只是想下载 Claude 桌面应用的安装包，但官方链路在国内不配合：更新接口 `api.anthropic.com` 与安装包托管的 Google Cloud Storage（`downloads.claude.ai`）在中国大陆经常被墙或限速，导致下载缓慢、失败。

`claude-app-mirror` 做的事情很窄：它不构建、不修改、不重打包 Claude，只把官方当前的桌面安装包拉下来，按版本探测结果发布到 GitHub Release，并同步一份到 Cloudflare R2 短链供国内下载。

## 镜像内容

- macOS 通用包（Apple Silicon + Intel）：`Claude-mac-universal.dmg`
- Windows x64：`Claude-win-x64.msix`
- Windows arm64：`Claude-win-arm64.msix`
- `SHA256SUMS.txt`：本次 Release 内所有资产的校验和
- `release-manifest.json`：本次探测到的上游指纹（版本、URL、内容哈希、大小）

## 为什么镜像 MSIX 而不是官网那个 `.exe`

官网 Windows 下载按钮给的 `ClaudeSetup.exe`（约 7MB）并不是自包含安装包，而是一个 **在线引导器**：运行时它会再去 `downloads.claude.ai`（GCS）下载真正的 ~220MB MSIX 再本地安装，且下载基址写死在已签名二进制里、会校验签名，无法重定向到镜像。所以镜像这个 exe 对国内场景没有意义。本项目改为直接镜像 **自包含、可离线安装** 的 `.msix`（Windows）与 `.dmg`（macOS）。

## 没有 Linux

Claude 官方没有 Linux 桌面客户端（官方更新接口对 linux 平台直接返回 `400 Platform must be darwin or win32`，官方推荐 Linux 用户使用 Claude Code CLI）。因此本项目不包含 Linux 产物。

## 版本号说明

macOS 与 Windows 当前来自同一发布、版本号锁步一致（例如 `1.9659.2`）。Release tag 形如：

```text
claude-app-v1.9659.2
```

版本号取自官方更新接口返回的 `currentRelease`，与安装包路径中的版本段一致。

## 怎么用

打开 [最新 GitHub Release](https://github.com/Wangnov/claude-app-mirror/releases/latest)，下载你的平台对应文件：

- macOS：`Claude-mac-universal.dmg`
- Windows x64：`Claude-win-x64.msix`
- Windows arm64：`Claude-win-arm64.msix`

也可以直接使用 R2 短链接（面向国内网络，只保留最新版）：

- macOS：[https://claudeapp.agentsmirror.com/latest/mac](https://claudeapp.agentsmirror.com/latest/mac)
- Windows x64：[https://claudeapp.agentsmirror.com/latest/win-x64](https://claudeapp.agentsmirror.com/latest/win-x64)
- Windows arm64：[https://claudeapp.agentsmirror.com/latest/win-arm64](https://claudeapp.agentsmirror.com/latest/win-arm64)
- 校验和：[https://claudeapp.agentsmirror.com/latest/checksums](https://claudeapp.agentsmirror.com/latest/checksums)

需要旧版本时，请到 [GitHub Releases](https://github.com/Wangnov/claude-app-mirror/releases) 按 tag 查找历史资产。

### 安装

- macOS：打开 `.dmg`，把 Claude 拖进“应用程序”。
- Windows：双击 `.msix`，由“应用安装程序”完成；或 PowerShell `Add-AppxPackage Claude-win-x64.msix`。MSIX 为已签名包，消费版 Windows 10/11 默认允许；锁策略企业机可能需要管理员放行已签名应用的侧载。

建议同时下载 `SHA256SUMS.txt` 核对文件完整性。

## 社区

本项目链接并认可 [LINUX DO](https://linux.do/) 社区。欢迎在社区讨论帖中交流下载链路、安装体验、校验结果和改进建议。

## 自动轮询

Cloudflare Cron Worker 每 15 分钟触发一次 GitHub Actions 的 `Mirror Claude Desktop Installers` workflow（仓库内 GitHub `schedule` 每 6 小时作为兜底）。

每次运行先做轻量探测：

- 对三个 `api.anthropic.com/api/desktop/.../latest/redirect` 端点取 307 跳转目标（含版本号与内容哈希）
- 对落地的 `downloads.claude.ai` 产物做 HEAD，读取 `Content-Length`、`ETag`、`Last-Modified`
- 与最新 Release 的 `release-manifest.json` 比对

如果没有变化，workflow 在探测阶段结束，不下载、不发布重复 Release。若发现新版本，则下载三个安装包、生成校验和与 manifest，发布新的 GitHub Release，并同步到 R2。

## 上游来源

- 更新/下载入口（稳定、无需鉴权）：`https://api.anthropic.com/api/desktop/<platform>/<arch>/<format>/latest/redirect`
  - `darwin/universal/dmg`、`win32/x64/msix`、`win32/arm64/msix`
- 实际产物托管：`https://downloads.claude.ai/releases/...`（Google Cloud Storage）

## 这个仓库不会做什么

- 不修改 Claude 安装包
- 不重打包、不破解安装器或授权逻辑
- 不镜像官网的 `ClaudeSetup.exe` 在线引导器，也不镜像 Squirrel 增量包（`.nupkg` / 自动更新 `.zip`）
- 不提供 Linux 桌面端（官方不存在）
- 不替代 Anthropic 的官方分发渠道

---

<a id="readme-en"></a>

# English

Sometimes you just want to download the Claude desktop app installer, but the official path is unreliable from mainland China: the update API (`api.anthropic.com`) and the Google Cloud Storage host that serves the installers (`downloads.claude.ai`) are frequently blocked or throttled there.

`claude-app-mirror` keeps the job deliberately narrow. It does not build, modify, or repackage Claude. It downloads the current official desktop installers, publishes them as GitHub Release assets when the upstream fingerprints change, and mirrors a copy to Cloudflare R2 short links for users behind a slow link.

## Mirrored assets

- macOS universal (Apple Silicon + Intel): `Claude-mac-universal.dmg`
- Windows x64: `Claude-win-x64.msix`
- Windows arm64: `Claude-win-arm64.msix`
- `SHA256SUMS.txt` for all assets in the release
- `release-manifest.json` with the upstream fingerprints (version, URL, content hash, size)

## Why MSIX, not the website `.exe`

The official Windows download button serves `ClaudeSetup.exe` (~7MB), which is not a self-contained installer but an **online bootstrapper**: at install time it re-downloads the real ~220MB MSIX from `downloads.claude.ai` (GCS), with the base URL baked into the signed binary and signature-checked, so it cannot be redirected to a mirror. Mirroring that stub is pointless for the slow-link use case. This project mirrors the **self-contained, offline-installable** `.msix` (Windows) and `.dmg` (macOS) instead.

## No Linux

Anthropic ships no official Linux desktop client (the update API returns `400 Platform must be darwin or win32` for linux, and official guidance points Linux users to the Claude Code CLI). So no Linux artifact is included.

## Version numbers

macOS and Windows currently come from the same release and share a lock-step version (for example `1.9659.2`). Release tags look like:

```text
claude-app-v1.9659.2
```

The version comes from the official update API's `currentRelease`, matching the version segment in the installer path.

## Usage

Open the [latest GitHub Release](https://github.com/Wangnov/claude-app-mirror/releases/latest) and download the asset for your platform:

- macOS: `Claude-mac-universal.dmg`
- Windows x64: `Claude-win-x64.msix`
- Windows arm64: `Claude-win-arm64.msix`

You can also use the R2 short links directly (mainland-China-friendly, latest-only):

- macOS: [https://claudeapp.agentsmirror.com/latest/mac](https://claudeapp.agentsmirror.com/latest/mac)
- Windows x64: [https://claudeapp.agentsmirror.com/latest/win-x64](https://claudeapp.agentsmirror.com/latest/win-x64)
- Windows arm64: [https://claudeapp.agentsmirror.com/latest/win-arm64](https://claudeapp.agentsmirror.com/latest/win-arm64)
- Checksums: [https://claudeapp.agentsmirror.com/latest/checksums](https://claudeapp.agentsmirror.com/latest/checksums)

For older versions, use [GitHub Releases](https://github.com/Wangnov/claude-app-mirror/releases) and download assets from the matching tag.

### Install

- macOS: open the `.dmg` and drag Claude into Applications.
- Windows: double-click the `.msix` (App Installer), or run `Add-AppxPackage Claude-win-x64.msix`. The MSIX is signed; consumer Windows 10/11 allows it by default. Locked-down machines may need an admin to allow signed-app sideloading.

Download `SHA256SUMS.txt` as well if you want to verify file integrity.

## Community

This project links back to and recognizes the [LINUX DO](https://linux.do/) community. Feedback on download availability, installation results, checksums, and improvement ideas is welcome.

## Polling

A Cloudflare Cron Worker triggers the `Mirror Claude Desktop Installers` workflow every 15 minutes (the in-repo GitHub `schedule` runs every 6 hours as a fallback).

Each run starts with a lightweight probe:

- Resolve the 307 target of the three `api.anthropic.com/api/desktop/.../latest/redirect` endpoints (the target carries the version and a content hash)
- HEAD the resulting `downloads.claude.ai` artifacts for `Content-Length`, `ETag`, `Last-Modified`
- Compare against the latest release's `release-manifest.json`

If nothing changed, the workflow stops after the probe. If a new version appears, it downloads the three installers, writes checksums and a manifest, publishes a new GitHub Release, and syncs to R2.

## Upstream sources

- Update/download entry points (stable, no auth): `https://api.anthropic.com/api/desktop/<platform>/<arch>/<format>/latest/redirect`
  - `darwin/universal/dmg`, `win32/x64/msix`, `win32/arm64/msix`
- Actual artifact hosting: `https://downloads.claude.ai/releases/...` (Google Cloud Storage)

## Non-goals

- It does not modify Claude installer packages
- It does not repackage or bypass installer or authorization logic
- It does not mirror the website `ClaudeSetup.exe` online bootstrapper, nor Squirrel incremental packages (`.nupkg` / auto-update `.zip`)
- It does not provide a Linux desktop client (none exists officially)
- It is not a replacement for Anthropic's official distribution channels
