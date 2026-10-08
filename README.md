<div align="center">

<picture>
  <source type="image/svg+xml" srcset="assets/banner.svg">
  <img src="assets/banner.png" alt="pi-bridges Banner" width="100%">
</picture>

# pi-matrix & pi-telegram

**Native, high-performance, zero-token-overhead Matrix and Telegram bridge extensions for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent).**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Pi Coding Agent](https://img.shields.io/badge/Agent-Pi%20Coding%20Agent-00d2ff.svg)](https://github.com/earendil-works/pi-coding-agent)
[![Matrix Protocol](https://img.shields.io/badge/Protocol-Matrix%20v1.11-0ebd8f.svg)](https://matrix.org)
[![Telegram Bot API](https://img.shields.io/badge/Protocol-Telegram%20Bot%20API-24A1DE.svg)](https://core.telegram.org/bots/api)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript-3178c6.svg)](https://www.typescriptlang.org/)

</div>

---

## ⚡ Overview

This repository provides dedicated, modular bridge extensions engineered specifically for **Pi Coding Agent**:

1. **`matrix/`** (`pi-matrix`): High-performance Matrix chat bridge. Injects messages directly into your active Pi TUI session, handles multimodal media, MSC3440 thread tracking, MSC2676 live progress edits, outbound media uplinks, and remote slash commands.
2. **`telegram/`** (`pi-telegram`): Direct Telegram Bot API bridge. Provides interactive inline quick actions, native photo/document uplinks, IPv4 DNS prioritization, and zero-token remote execution.

Unlike traditional chat wrappers that spin up disconnected subagent processes or bloat context with boilerplate prompts, these extensions directly bind into Pi's event lifecycle via `pi.sendUserMessage()` with `{ deliverAs: "followUp" }` and correlate turns with unique metadata stamps stripped before LLM dispatch.

---

## 📁 Repository Structure

```text
pi-matrix/
├── index.ts               # Root entrypoint (re-exports matrix bridge)
├── package.json           # Extension metadata & dependencies
├── flake.nix              # Nix flake dev environment & package exports
├── flake.lock
├── tsconfig.json          # TypeScript compilation settings
├── assets/                # Visual assets & banners
│   ├── banner.jpg
│   └── banner.png
├── matrix/                # Matrix Bridge Extension
│   ├── index.ts           # Matrix bridge entrypoint
│   └── src/
│       ├── api.ts         # Matrix client (CS-API sync, messages, threads, uploads, reactions)
│       ├── cache.ts       # Bounded event & message deduplication cache
│       ├── commands.ts    # Slash commands (/abort, /sh, /model, /thinking, etc.)
│       ├── config.ts      # Matrix configuration & sync token loader
│       ├── formatter.ts   # Markdown & Persian BiDi formatting
│       ├── progress.ts    # Debounced live progress reporter (m.replace)
│       ├── queue.ts       # Concurrency-safe FIFO turn queue with ID matching
│       └── types.ts       # Matrix bridge type definitions
└── telegram/              # Telegram Bridge Extension
    ├── index.ts           # Telegram bridge entrypoint
    └── src/
        ├── api.ts         # Telegram Bot API client (polling, sendPhoto, inline keyboards)
        ├── cache.ts       # Message deduplication cache
        ├── commands.ts    # Slash commands & inline buttons
        ├── config.ts      # Telegram configuration & offset persistence
        ├── formatter.ts   # Telegram MarkdownV2 / HTML formatter
        ├── progress.ts    # Live status updater
        ├── queue.ts       # Multi-turn FIFO queue with ID matching
        └── types.ts       # Telegram bridge type definitions
```

---

## ✨ Features

### 🟢 Matrix Bridge (`matrix/`)
- **🚀 Direct Session Injection**: Dispatched directly via `pi.sendUserMessage()` with zero token bloat.
- **🧵 Native Thread Support (MSC3440 / MSC2836)**: Replies to messages directly within their originating Matrix threads.
- **🛡️ Strict Turn & Queue Isolation**: Uses tagged turn matching (`before_agent_start`) to prevent cross-talk with local terminal TUI turns or Telegram messages.
- **📤 Outbound Media Uplink**: Automatically uploads generated media (`.png`, `.jpg`, `.svg`, `.pdf`) produced by Pi tools to Matrix.
- **🛑 Interactive Instant Abort**: Interrupt running jobs via `/abort` or by reacting with 🛑.
- **💻 Zero-Token Shell Commands (`/sh`)**: Execute system commands on the host directly from Matrix with strict allowlist enforcement.
- **🧹 In-Place Updates (`m.replace`)**: Progress edits cleanly in-place with concurrency locking and guaranteed redaction on completion or failure.
- **📦 PDU Chunking Protection**: Splits messages over 4,000 chars cleanly to prevent `M_TOO_LARGE`.
- **🌐 Persian & BiDi Formatting**: Intelligent RTL wrapping for Persian text and LTR for code blocks, lists, and tables without markdown mangling.

### 🔵 Telegram Bridge (`telegram/`)
- **⚡ Zero-Token Quick Actions**: Interactive inline buttons for `/new`, `/status`, `/compact`, and `/abort`.
- **👀 Fast Reactive Feedback**: Acknowledges incoming prompts with `👀` and marks completion with `✅`.
- **📸 Auto-Adaptive Media Uplink**: Auto-routes images as `sendPhoto` and files/logs as `sendDocument`.
- **🌐 Network Resilience**: Uses IPv4 DNS order to prevent IPv6 timeouts on Node 24+.
- **🔒 Granular RBAC**: Restrict bot access by numerical user ID and usernames.
- **🔕 Silent Inactive Boot**: Automatically suppresses startup notifications when no bot token is configured.

---

## ⚙️ Configuration Reference

### Matrix Configuration (`~/.pi/agent/matrix.json`)

```json
{
  "homeserver": "https://matrix.example.com",
  "accessToken": "syt_xxxxxxxxxxxxxxxxxxxx",
  "botUserId": "@pi_bot:matrix.example.com",
  "allowedUsers": [
    "@you:matrix.example.com"
  ],
  "autoStart": true,
  "progressCooldownSeconds": 5,
  "progressMode": "edit"
}
```

*Note: You can omit `accessToken` from `matrix.json` and provide `$MATRIX_ACCESS_TOKEN` in your environment or via secret management (`sops-nix`).*

### Telegram Configuration (`~/.pi/agent/telegram.json`)

```json
{
  "botToken": "123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ",
  "allowedUsers": [ 123456789 ],
  "allowedUsernames": [ "your_username" ],
  "autoStart": true,
  "progressMode": "edit",
  "progressCooldownSeconds": 3
}
```

*Note: Backward-compatible with `~/.config/telegram/config.json`. You can also specify `TELEGRAM_BOT_TOKEN` in your environment or load it via `/run/secrets/telegram-bot-token`.*

---

## 📦 Declarative Installation (NixOS / Home-Manager)

Link the extension directories declaratively in your Home-Manager configuration:

### Option A: Using Flake Packages (Recommended)

```nix
# flake.nix input:
inputs.pi-matrix.url = "github:surtr85/pi-matrix";

# In your home-manager module (e.g. modules/home/ai/pi/default.nix):
let
  piAgentDir = ".pi/agent";
in
{
  # Link Matrix bridge extension from flake output
  home.file."${piAgentDir}/extensions/matrix".source = "${inputs.pi-matrix.packages.${pkgs.system}.matrix}";

  # Link Telegram bridge extension from flake output
  home.file."${piAgentDir}/extensions/telegram".source = "${inputs.pi-matrix.packages.${pkgs.system}.telegram}";

  # Declarative configuration
  home.file."${piAgentDir}/matrix.json".text = builtins.toJSON {
    homeserver = "https://matrix.example.com";
    botUserId = "@pi_bot:matrix.example.com";
    allowedUsers = [ "@you:matrix.example.com" ];
    autoStart = true;
    progressCooldownSeconds = 5;
    progressMode = "edit";
  };
}
```

### Option B: Using Direct Directory Links

```nix
inputs.pi-matrix.url = "github:surtr85/pi-matrix";
inputs.pi-matrix.flake = false;

# In your home-manager module:
home.file."${piAgentDir}/extensions/matrix".source = "${inputs.pi-matrix}/matrix";
home.file."${piAgentDir}/extensions/telegram".source = "${inputs.pi-matrix}/telegram";
```

---

## 🎮 Interactive Slash Commands

Both bridges provide remote control over your Pi session:

| Command | Description |
| :--- | :--- |
| `/abort` or `/stop` | Instantly interrupts and cancels active agent execution. |
| `/sh <command>` | Runs a host shell command directly without burning LLM tokens (requires `allowedUsers`). |
| `/upload <path>` | Uploads a file or image from the host machine directly into the chat (requires `allowedUsers`). |
| `/new` or `/reset` | Resets the conversation and starts a new session immediately. |
| `/status` | Shows connection status, active model, thinking level, and token metrics. |
| `/model [id]` | Shows the active model or switches to another available model. |
| `/thinking [level]`| Sets thinking/reasoning depth (`off`, `low`, `medium`, `high`, `max`). |
| `/compact [prompt]`| Triggers context compaction with optional instructions. |
| `/help` | Shows the command cheat sheet. |

---

## 📄 License

Distributed under the [MIT License](LICENSE).
