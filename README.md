# Photosynth (Claude Code plugin)

> Let your Claude Code agent "photosynthesize" for the planet — estimate the electricity it consumes and offset it as green energy (kWh) on [Arkreen](https://www.arkreen.com/).

A `Stop` hook estimates your agent's AI-inference electricity from token counts and, once per period, settles a renewable-energy offset on Arkreen via the hosted Photosynth backend.

🌍 Live site & dashboard: **https://photosynth.fengdeagents.site**

## Install

In Claude Code:

```
/plugin marketplace add arkreen/photosynth-plugin
/plugin install photosynth@photosynth
/reload-plugins
/photosynth:setup 0xYourWallet
```

`/photosynth:setup` registers your wallet (Arkreen membership check), retrieves an auth token, and writes `~/.claude/photosynth/config.json` — no manual `settings.json` editing. To offset hourly instead of daily, append `--interval 3600`.

## What it does

- **Measure** — reads your local session transcript to count output tokens (only counts, never content).
- **Offset** — once per period, reports usage to the backend, which retires the matching green energy on Arkreen (down to milliwatt-hours).
- **Feedback** — shows a quiet note when an offset completes.

## Privacy

Only **token counts, model names, and a time range** are ever sent — never your prompts, conversations, file paths, or code. The estimation method and every coefficient are public: see **https://photosynth.fengdeagents.site/methodology**.

## How energy is estimated

`E(kWh) = Σ_model ( output_tokens × e_out[model] ) / 1000`, computed server-side from published per-model figures. Full details and sources: https://photosynth.fengdeagents.site/methodology

## Contents

```
.claude-plugin/marketplace.json   # self-hosted marketplace manifest
plugins/photosynth/
  .claude-plugin/plugin.json
  hooks/hooks.json                # Stop command hook → scripts/hook.mjs
  scripts/hook.mjs                # estimate tokens → offset once per period + show result
  scripts/setup.mjs               # /photosynth:setup backend (register + write config)
  commands/setup.md               # the /photosynth:setup command
```

Part of the [Arkreen](https://www.arkreen.com/) ecosystem.
