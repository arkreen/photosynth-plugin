# Photosynth (Claude Code, OpenAI Codex CLI & Kimi Code CLI plugin)

> Let your AI agent "photosynthesize" for the planet — estimate the electricity it consumes and offset it as green energy (kWh) on [Arkreen](https://www.arkreen.com/).

A `Stop` hook estimates your agent's AI-inference electricity from token counts and, once per period, settles a renewable-energy offset on Arkreen via the hosted Photosynth backend.

🌍 Live site & dashboard: **https://photosynth.arkreen.com**

---

## Claude Code

### Install

In Claude Code:

```
/plugin marketplace add https://github.com/arkreen/photosynth-plugin.git
/plugin install photosynth@photosynth
/reload-plugins
/photosynth:setup 0xYourWallet
```

`/photosynth:setup` registers your wallet (Arkreen membership check), retrieves an auth token, and writes `~/.claude/photosynth/config.json` — no manual `settings.json` editing. To offset hourly instead of daily, append `--interval 3600`.

### Commands

After install, the plugin provides two slash commands:

- `/photosynth:setup 0xYourWallet` — one-time wallet registration + config (covered above).
- `/photosynth:share` — open the X (Twitter) compose window pre-filled with your lifetime offset stats (kWh retired, session count, tagged `@arkreen_network`). Uses Twitter Web Intent — no Twitter API authorization is required from either us or you. Tip: `/ph<Tab>sh<Tab>` is enough to invoke it.

---

## OpenAI Codex CLI

### Install

[OpenAI Codex CLI](https://github.com/openai/codex) has a native `Stop` hook system (`~/.codex/hooks.json`).

```bash
# 1. Clone this repo and run the installer
git clone https://github.com/arkreen/photosynth-plugin.git
cd photosynth-plugin/plugins/photosynth-codex/scripts
node install.mjs

# 2. Register your wallet
node setup.mjs --wallet 0xYourWallet
```

The installer will:
- Copy `hook.mjs` and `setup.mjs` into `~/.codex/photosynth/`
- Merge a `Stop` command hook into `~/.codex/hooks.json` (idempotent; existing entries preserved)

On your next `codex` run, the TUI will prompt you to **TRUST the new hook** — accept it, or type `/hooks` to review. This is a one-time Codex-specific UX, separate from registration.

To offset hourly instead of daily, append `--interval 3600` to the setup command.

---

## Kimi Code CLI

### Install

Kimi Code CLI also supports lifecycle hooks via `~/.kimi/config.toml`.

**One-command install:**

```bash
curl -fsSL https://raw.githubusercontent.com/arkreen/photosynth-plugin/main/plugins/photosynth-kimi/scripts/install.mjs | node
```

Or manually:

```bash
# 1. Clone this repo and run the installer
git clone https://github.com/arkreen/photosynth-plugin.git
cd photosynth-plugin/plugins/photosynth-kimi/scripts
node install.mjs

# 2. Register your wallet
node setup.mjs --wallet 0xYourWallet

# 3. Restart Kimi CLI (or start a new session)
```

The installer will:
- Copy `hook.mjs` and `setup.mjs` into `~/.kimi/photosynth/`
- Append a `Stop` hook entry to your `~/.kimi/config.toml`

To offset hourly instead of daily, append `--interval 3600` to the setup command.

---

## What it does

- **Measure** — reads your local session transcript (Claude), rollout JSONL (Codex), or logs (Kimi) to count output tokens (only counts, never content).
- **Offset** — once per period, reports usage to the backend, which retires the matching green energy on Arkreen (down to milliwatt-hours).
- **Feedback** — shows a quiet note when an offset completes (Claude); writes to stderr logs (Codex, Kimi).

## Privacy

Only **token counts, model names, and a time range** are ever sent — never your prompts, conversations, file paths, or code. The estimation method and every coefficient are public: see **https://photosynth.arkreen.com/methodology**.

## How energy is estimated

`E(kWh) = Σ_model ( output_tokens × e_out[model] ) / 1000`, computed server-side from published per-model figures. Full details and sources: https://photosynth.arkreen.com/methodology

## Contents

```
.claude-plugin/marketplace.json   # self-hosted marketplace manifest
plugins/photosynth/
  .claude-plugin/plugin.json
  hooks/hooks.json                # Stop command hook → scripts/hook.mjs
  scripts/hook.mjs                # estimate tokens → offset once per period + show result
  scripts/setup.mjs               # /photosynth:setup backend (register + write config)
  commands/setup.md               # the /photosynth:setup command
plugins/photosynth-codex/
  scripts/hook.mjs                # Codex Stop hook (parses ~/.codex/sessions/.../rollout-*.jsonl)
  scripts/setup.mjs               # Codex setup (writes ~/.codex/photosynth/config.json)
  scripts/install.mjs             # Codex installer (merges ~/.codex/hooks.json)
plugins/photosynth-kimi/
  scripts/hook.mjs                # Kimi Stop hook (scans ~/.kimi/logs/)
  scripts/setup.mjs               # Kimi setup (writes ~/.kimi/photosynth/config.json)
  scripts/install.mjs             # Kimi one-command installer (patches ~/.kimi/config.toml)
```

Part of the [Arkreen](https://www.arkreen.com/) ecosystem.
