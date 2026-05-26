#!/usr/bin/env node
// Photosynth for Kimi Code CLI — Stop hook.
// Scans Kimi logs to count tokens per period and offsets them on Arkreen.
//
// Design principles (same as Claude version):
//   - Fail silently (exit 0), never block the user.
//   - Short-circuit when possible: check state files, then decide.
//   - Only Node built-ins, cross-platform.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';

const DIR = path.join(os.homedir(), '.kimi', 'photosynth');
const CONFIG_PATH = path.join(DIR, 'config.json');
const STATE_PATH = path.join(DIR, 'state.json');
const KIMI_LOGS_DIR = path.join(os.homedir(), '.kimi', 'logs');

// Any uncaught error -> silent exit, never disturb the user.
main().catch(() => process.exit(0));

async function main() {
  const input = readStdinJson();
  const config = readJson(CONFIG_PATH);
  if (!config || !config.wallet_address) process.exit(0); // not configured

  const state = readJson(STATE_PATH) || {};
  const now = new Date();
  const intervalSec = config.offset_interval_seconds ?? 86400;
  const period = periodInfo(now, intervalSec);

  // ── ① Show result of previous offset (only when pending exists) ──
  if (state.pending && state.pending.shown !== true) {
    const res = await getStatus(config, state.pending.period);
    if (res && res.status === 'completed') {
      // Kimi hook runner does not support systemMessage display,
      // so we write a note to stderr (visible in Kimi logs) and clear pending.
      console.error(`🌱 Photosynth: offset completed ✅ retired ${fmtKwh(res.kwh)} green energy (Arkreen).`);
      state.pending = null;
      writeJson(STATE_PATH, state);
    } else if (res && res.status === 'failed') {
      console.error(`🌱 Photosynth: offset for ${state.pending.period} failed after retries; will retry next period.`);
      state.pending = null;
      writeJson(STATE_PATH, state);
    }
  }

  // ── ② Periodic offset trigger (only if not done this period) ──
  if (state.last_offset_period !== period.key) {
    await maybeOffset(input, config, state, now, period);
  }

  process.exit(0);
}

async function maybeOffset(input, config, state, now, period) {
  // Rate-limit: minimum interval between attempts.
  const minIntervalMs = (config.min_attempt_interval_seconds ?? 60) * 1000;
  if (state.last_attempt && now.getTime() - Date.parse(state.last_attempt) < minIntervalMs) return;
  state.last_attempt = now.toISOString();
  writeJson(STATE_PATH, state);

  // Parse Kimi logs for this period's token usage.
  const { usageByModel, totalOutput, timeRange } = parseKimiLogs(period.startMs);
  const minOut = config.min_output_tokens ?? 2000;
  if (totalOutput < minOut) return; // below threshold -> skip silently

  const payload = {
    schema_version: config.schema_version ?? '1',
    wallet_address: config.wallet_address,
    local_date: period.key,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    request_id: crypto.randomUUID(),
    time_range: timeRange,
    usage_by_model: usageByModel,
    client: { plugin_version: config.plugin_version ?? '0.1.0', platform: 'kimi-cli' },
  };

  const res = await postOffset(config, payload);
  if (!res) return null; // network failure -> retry next interval

  if (res.status === 'accepted' || res.status === 'duplicate') {
    state.last_offset_period = period.key;
    state.pending = { period: period.key, shown: false };
    writeJson(STATE_PATH, state);
    return null;
  }
  if (res.status === 'disabled') {
    state.last_offset_period = period.key;
    writeJson(STATE_PATH, state);
    return null;
  }
  if (res.status === 'rejected') {
    state.last_offset_period = period.key;
    if (res.reason === 'upgrade_required' && !state.upgrade_notified) {
      state.upgrade_notified = true;
      writeJson(STATE_PATH, state);
      console.error('🌱 Photosynth: upgrade required; please update to continue offsetting.');
    }
    writeJson(STATE_PATH, state);
    return null;
  }
  return null;
}

// ── Kimi log parser ──
// Scans ~/.kimi/logs/kimi.*.log for lines matching:
//   "<session_id> - LLM step completed in Xs (input=N, output=M)"
// Also extracts timestamps from log lines like:
//   "2026-05-24 16:47:20.626 | INFO | ..."
function parseKimiLogs(startMs) {
  const usageByModel = {};
  let totalOutput = 0;
  let minTs = null, maxTs = null;

  const modelName = 'kimi-for-coding'; // Kimi CLI default; logs do not include per-step model name

  // Read all log files modified since startMs
  let logFiles = [];
  try {
    logFiles = fs.readdirSync(KIMI_LOGS_DIR)
      .filter(f => f.startsWith('kimi.') && f.endsWith('.log'))
      .map(f => path.join(KIMI_LOGS_DIR, f))
      .filter(p => {
        try {
          const stat = fs.statSync(p);
          return stat.mtimeMs >= startMs;
        } catch { return false; }
      });
  } catch { /* logs dir missing -> no usage */ }

  // Regex for token lines
  const tokenRe = /LLM step completed in [\d.]+s \(input=(\d+|\?), output=(\d+|\?)\)/;
  // Regex for timestamp at start of log line
  const tsRe = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d+)/;

  for (const logPath of logFiles) {
    let data;
    try { data = fs.readFileSync(logPath, 'utf8'); } catch { continue; }

    for (const line of data.split('\n')) {
      if (!line.includes('LLM step completed')) continue;

      // Extract timestamp
      const tsMatch = line.match(tsRe);
      let ts = NaN;
      if (tsMatch) {
        ts = Date.parse(`${tsMatch[1]}T${tsMatch[2]}Z`);
      }
      if (!Number.isFinite(ts) || ts < startMs) continue; // only count this period

      // Extract tokens
      const m = line.match(tokenRe);
      if (!m) continue;
      const inputTokens = m[1] === '?' ? 0 : parseInt(m[1], 10);
      const outputTokens = m[2] === '?' ? 0 : parseInt(m[2], 10);

      if (!usageByModel[modelName]) {
        usageByModel[modelName] = {
          output_tokens: 0, input_tokens: 0,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        };
      }
      usageByModel[modelName].input_tokens += inputTokens;
      usageByModel[modelName].output_tokens += outputTokens;
      totalOutput += outputTokens;

      if (minTs === null || ts < minTs) minTs = ts;
      if (maxTs === null || ts > maxTs) maxTs = ts;
    }
  }

  const timeRange = minTs !== null
    ? { start: new Date(minTs).toISOString(), end: new Date(maxTs).toISOString() }
    : null;
  return { usageByModel, totalOutput, timeRange };
}

// ── Network (HTTP) ──

function getStatus(config, period) {
  const u = `${config.endpoint}/status?wallet=${encodeURIComponent(config.wallet_address)}&date=${encodeURIComponent(period)}`;
  return request(u, { method: 'GET', headers: authHeader(config) });
}

function postOffset(config, payload) {
  return request(`${config.endpoint}/offset`, { method: 'POST', headers: authHeader(config), body: payload });
}

function authHeader(config) {
  return config.auth_token ? { Authorization: `Bearer ${config.auth_token}` } : {};
}

function request(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch { return resolve(null); }
    const lib = u.protocol === 'https:' ? https : http;
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { ...headers },
    };
    if (data) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = data.length;
    }
    const req = lib.request(opts, (resp) => {
      let buf = '';
      resp.on('data', (c) => (buf += c));
      resp.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}

// ── Utils ──

function readStdinJson() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return {}; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* silent */ }
}

function periodInfo(now, intervalSec) {
  const midnight = startOfLocalDay(now);
  const intervalMs = intervalSec * 1000;
  const bucket = Math.floor((now.getTime() - midnight) / intervalMs);
  const startMs = midnight + bucket * intervalMs;
  const d = new Date(startMs);
  let key = localDate(d);
  if (intervalSec < 86400) {
    key += '-' + pad(d.getHours());
    if (intervalSec < 3600) key += pad(d.getMinutes());
  }
  return { key, startMs };
}

function pad(n) { return String(n).padStart(2, '0'); }

function localDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

function fmtKwh(kwh) {
  if (typeof kwh !== 'number') return '?';
  return kwh < 0.001 ? `${(kwh * 1000).toFixed(2)} Wh` : `${kwh.toFixed(4)} kWh`;
}
