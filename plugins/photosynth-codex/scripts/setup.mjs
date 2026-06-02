#!/usr/bin/env node
// Photosynth for OpenAI Codex CLI — setup script.
// Registers the wallet (Arkreen membership check) → obtains an auth_token →
// writes ~/.codex/photosynth/config.json (overridable via CODEX_HOME). The
// Codex Stop hook then reads that config.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = parseArgs(process.argv.slice(2));
if (!args.wallet) {
  console.error('Usage: setup.mjs --wallet 0x... [--endpoint ...] [--interval 86400] [--threshold 2000] [--token <auth_token>] [--invite <code>]');
  process.exit(1);
}

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const DIR = path.join(CODEX_HOME, 'photosynth');
const CONFIG_PATH = path.join(DIR, 'config.json');
const endpoint = args.endpoint || 'https://photosynth.fengdeagents.site';
const interval = Number(args.interval) || 86400;
const threshold = Number(args.threshold) || 2000;

main().catch((e) => { console.error('Setup failed:', e.message || e); process.exit(1); });

async function main() {
  let token = args.token;
  let registered = null;
  if (!token) {
    const r = await register(endpoint, args.wallet, args.invite);
    token = r.auth_token;
    registered = r.registered; // 'new' | 'existing'
  }

  const config = {
    wallet_address: args.wallet,
    auth_token: token,
    endpoint,
    min_output_tokens: threshold,
    offset_interval_seconds: interval,
    min_attempt_interval_seconds: 60,
    schema_version: '1',
    plugin_version: '0.1.0',
  };
  fs.mkdirSync(DIR, { recursive: true });
  writeJsonAtomic(CONFIG_PATH, config);

  console.log('✅ Photosynth for Codex configured.');
  console.log(`  wallet   = ${config.wallet_address}${registered ? ` (${registered})` : ''}`);
  console.log(`  endpoint = ${endpoint}`);
  console.log(`  cadence  = every ${interval}s (${interval === 86400 ? 'daily' : interval === 3600 ? 'hourly' : 'custom'})`);
  console.log(`  config   → ${CONFIG_PATH}`);
  console.log('');
  console.log('Make sure ~/.codex/hooks.json has the Stop hook (the installer does this).');
  console.log('On your next `codex` run, the TUI will prompt to TRUST the hook — accept it, or type /hooks to review.');
  console.log('Only token counts / model / time are ever sent — never your conversations.');
}

async function register(endpoint, wallet, invite) {
  let res;
  try {
    res = await fetch(`${endpoint}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: wallet, invite_code: invite }),
    });
  } catch (e) {
    throw new Error(`cannot reach ${endpoint} (${e.message})`);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`registration failed (HTTP ${res.status}): ${t}`);
  }
  const data = await res.json();
  if (!data.auth_token) throw new Error('registration response missing auth_token');
  return data;
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

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
