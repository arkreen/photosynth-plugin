#!/usr/bin/env node
// Photosynth for OpenAI Codex CLI — one-time installer.
//
// 1. Copies hook.mjs and setup.mjs into ~/.codex/photosynth/.
// 2. Merges a `Stop` command hook into ~/.codex/hooks.json (idempotent;
//    existing entries are preserved). If a `~/.codex/config.toml` already
//    declares an inline `[hooks]` table, Codex still reads `hooks.json`
//    alongside it — both forms are recognized.
// 3. Reminds the user that Codex will prompt them to TRUST the new hook
//    on the next `codex` run (this is a Codex-specific first-run UX).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const __dir = path.dirname(url.fileURLToPath(import.meta.url));
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const PHOTOSYNTH_DIR = path.join(CODEX_HOME, 'photosynth');
const HOOKS_JSON = path.join(CODEX_HOME, 'hooks.json');

const hookSrc = path.join(__dir, 'hook.mjs');
const setupSrc = path.join(__dir, 'setup.mjs');
if (!fs.existsSync(hookSrc) || !fs.existsSync(setupSrc)) {
  console.error(`Cannot find hook.mjs/setup.mjs next to install.mjs (${__dir}).`);
  console.error('Run this installer from inside the plugins/photosynth-codex/scripts/ directory.');
  process.exit(1);
}

// 1. Copy scripts.
fs.mkdirSync(PHOTOSYNTH_DIR, { recursive: true });
const hookDst = path.join(PHOTOSYNTH_DIR, 'hook.mjs');
const setupDst = path.join(PHOTOSYNTH_DIR, 'setup.mjs');
fs.copyFileSync(hookSrc, hookDst);
fs.copyFileSync(setupSrc, setupDst);
console.log(`📁 Scripts installed → ${PHOTOSYNTH_DIR}`);

// 2. Merge the Stop hook into hooks.json (preserve any existing content).
fs.mkdirSync(path.dirname(HOOKS_JSON), { recursive: true });
const existing = readJson(HOOKS_JSON) || {};
const next = structuredClone(existing);
next.hooks = next.hooks || {};
next.hooks.Stop = Array.isArray(next.hooks.Stop) ? next.hooks.Stop : [];

const command = `node "${hookDst}"`;
const isOurs = (group) =>
  Array.isArray(group.hooks) && group.hooks.some((h) => typeof h.command === 'string' && h.command.includes('photosynth') && h.command.includes('hook.mjs'));

const entry = { hooks: [{ type: 'command', command, timeout: 30 }] };
const idx = next.hooks.Stop.findIndex(isOurs);
if (idx >= 0) {
  next.hooks.Stop[idx] = entry;
  console.log(`🔧 Refreshed existing Photosynth Stop hook in ${HOOKS_JSON}`);
} else {
  next.hooks.Stop.push(entry);
  console.log(`🔧 Stop hook added to ${HOOKS_JSON}`);
}
writeJsonAtomic(HOOKS_JSON, next);

console.log('');
console.log('✅ Installation complete.');
console.log('');
console.log('Next steps:');
console.log(`  1) Register your wallet:   node ${setupDst} --wallet 0xYourWallet`);
console.log('  2) Start (or restart) Codex. On first launch you\'ll be prompted to TRUST the new hook —');
console.log('     accept it, or type /hooks in the TUI to review.');
console.log('');
console.log('Only token counts / model / time are ever sent to the Photosynth backend — never your conversations.');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
