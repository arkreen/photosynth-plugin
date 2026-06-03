#!/usr/bin/env node
// Photosynth /photosynth:share — open the user's default browser at an X
// (Twitter) compose window pre-filled with their lifetime offset stats.
//
// No Twitter API authorization is required. We construct an X Web Intent
// URL (https://x.com/intent/post?text=...) and the user's logged-in X
// session in the browser handles the rest.
//
// The tweet text + intent URL are both rendered server-side from a
// template, so the wording can be updated without re-releasing the plugin.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'photosynth', 'config.json');
const args = parseArgs(process.argv.slice(2));
const variant = args.variant || 'total';

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch {
  console.error('Photosynth is not configured. Run /photosynth:setup 0xYourWallet first.');
  process.exit(1);
}
if (!config.wallet_address || !config.auth_token || !config.endpoint) {
  console.error(`Photosynth config at ${CONFIG_PATH} is incomplete (missing wallet/auth_token/endpoint).`);
  process.exit(1);
}

main().catch((e) => { console.error('Share failed:', e.message || e); process.exit(1); });

async function main() {
  const url = `${config.endpoint}/share/preview?wallet=${encodeURIComponent(config.wallet_address)}&variant=${encodeURIComponent(variant)}`;
  let res;
  try {
    res = await fetch(url, { headers: { 'Authorization': `Bearer ${config.auth_token}` } });
  } catch (e) {
    throw new Error(`cannot reach ${config.endpoint} (${e.message})`);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`backend ${res.status}: ${t}`);
  }
  const data = await res.json();

  if (!data.eligible) {
    console.log('🌱 Photosynth — nothing to share yet.');
    console.log('   No completed offsets on record for this wallet.');
    console.log('   Let your agent run a few sessions; the next Stop hook will settle one,');
    console.log('   and then /photosynth:share will have something to brag about.');
    return;
  }

  console.log('🌱 Photosynth — tweet preview:\n');
  for (const line of data.text.split('\n')) console.log('   ' + line);
  console.log(`\nStats: ${data.stats.kWh} kWh across ${data.stats.sessions} sessions${data.stats.since ? ` (since ${data.stats.since})` : ''}\n`);
  console.log('Opening X compose window in your default browser...');
  console.log('(If it does not open — headless / SSH session — paste this URL manually:');
  console.log(`  ${data.intent_url})\n`);
  console.log('Your logged-in X session will pre-populate the composer. Edit before posting if you like.');
  console.log('No Twitter API authorization is needed — Web Intent is a public URL mechanism.');

  openInBrowser(data.intent_url);
}

// Cross-platform "open this URL in the default browser", zero deps.
function openInBrowser(url) {
  const p = os.platform();
  const cmd = p === 'darwin' ? 'open'
            : p === 'win32'  ? 'cmd'
            :                  'xdg-open';
  const argv = p === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, argv, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // The "paste URL manually" line above is the user-visible fallback.
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) continue;
    a = a.slice(2);
    const eq = a.indexOf('=');
    if (eq >= 0) out[a.slice(0, eq)] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[a] = argv[++i];
    else out[a] = true;
  }
  return out;
}
