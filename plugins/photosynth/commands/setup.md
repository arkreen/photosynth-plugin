---
description: Register your wallet and configure Photosynth (one-time setup)
argument-hint: "<wallet-address>"
allowed-tools: Bash(node:*)
---

The user wants to set up Photosynth for wallet: `$ARGUMENTS`

If `$ARGUMENTS` is empty, ask the user for their wallet address and stop here.

Otherwise, run exactly this command and show the user its output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --wallet "$ARGUMENTS" --endpoint https://photosynth.fengdeagents.site
```

On success, tell the user:
- Photosynth is now active; it will automatically offset their agent's electricity once per day.
- They can watch activity on the live dashboard: https://photosynth.fengdeagents.site/admin
- If the hook does not seem to fire, suggest running `/reload-plugins`.
- To offset hourly instead of daily (e.g. for testing), re-run with an extra `--interval 3600`.

Only token counts, model names, and a time range are ever sent — never their conversations or code.
