#!/usr/bin/env node
// Photosynth for Kimi Code CLI — one-command installer.
// Copies scripts into ~/.kimi/photosynth and appends the Stop hook to ~/.kimi/config.toml.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const KIMI_DIR = path.join(os.homedir(), '.kimi');
const PHOTOSYNTH_DIR = path.join(KIMI_DIR, 'photosynth');
const CONFIG_TOML = path.join(KIMI_DIR, 'config.toml');

main().catch((e) => { console.error('Install failed:', e.message || e); process.exit(1); });

async function main() {
  // 1. Ensure source files exist (assumes install.mjs is run from the repo root or alongside hook.mjs/setup.mjs)
  const srcDir = path.dirname(new URL(import.meta.url).pathname);
  const hookSrc = path.join(srcDir, 'hook.mjs');
  const setupSrc = path.join(srcDir, 'setup.mjs');

  if (!fs.existsSync(hookSrc)) throw new Error(`hook.mjs not found at ${hookSrc}`);
  if (!fs.existsSync(setupSrc)) throw new Error(`setup.mjs not found at ${setupSrc}`);

  // 2. Copy to ~/.kimi/photosynth/
  fs.mkdirSync(PHOTOSYNTH_DIR, { recursive: true });
  fs.copyFileSync(hookSrc, path.join(PHOTOSYNTH_DIR, 'hook.mjs'));
  fs.copyFileSync(setupSrc, path.join(PHOTOSYNTH_DIR, 'setup.mjs'));
  console.log(`📁 Scripts installed to ${PHOTOSYNTH_DIR}`);

  // 3. Patch ~/.kimi/config.toml to add the Stop hook
  if (!fs.existsSync(CONFIG_TOML)) {
    throw new Error(`Kimi config not found at ${CONFIG_TOML}. Please run Kimi CLI at least once first.`);
  }

  let toml = fs.readFileSync(CONFIG_TOML, 'utf8');
  const hookCommand = `node ${path.join(PHOTOSYNTH_DIR, 'hook.mjs')}`;

  // Check if already installed
  if (toml.includes(hookCommand)) {
    console.log('✅ Stop hook already present in ~/.kimi/config.toml');
  } else {
    // Remove empty `hooks = []` if present, then append hook block
    toml = toml.replace(/^hooks = \[\]\s*$/gm, '');
    toml += `\n[[hooks]]\nevent = "Stop"\ncommand = "${hookCommand}"\ntimeout = 10\n`;
    fs.writeFileSync(CONFIG_TOML, toml);
    console.log('🔧 Stop hook added to ~/.kimi/config.toml');
  }

  console.log('');
  console.log('Next step: register your wallet');
  console.log(`  node ${path.join(PHOTOSYNTH_DIR, 'setup.mjs')} --wallet 0xYOUR_WALLET`);
  console.log('');
  console.log('Then restart Kimi CLI (or start a new session) for the hook to take effect.');
}
