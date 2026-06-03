---
description: Share your Photosynth offset total on X (Twitter)
allowed-tools: Bash(node:*)
---

The user wants to share their Photosynth total on X.

Run exactly this command and show the user its output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/share.mjs"
```

The script reads the user's wallet from `~/.claude/photosynth/config.json`,
asks the backend for a pre-rendered tweet (with their lifetime kWh and
session count), prints a preview to the terminal, and opens the user's
default browser at the X compose window with the tweet pre-filled.

Tell the user:
- The X compose window opens in their default browser; their logged-in
  X session populates the composer automatically.
- They can edit the tweet before posting.
- No Twitter / X API authorization is required — Web Intent is a public
  URL mechanism, we never touch their credentials.
- If the browser doesn't open (headless / SSH session), the script also
  prints the X Intent URL so they can paste it manually.
