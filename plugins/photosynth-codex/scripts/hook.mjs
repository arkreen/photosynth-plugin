#!/usr/bin/env node
// Photosynth for OpenAI Codex CLI — Stop hook.
//
// Codex fires Stop after each turn. We read the session rollout JSONL whose
// path is passed on stdin as `transcript_path`, sum this-period's per-turn
// token deltas (EventMsg::TokenCount.info.last_token_usage), and POST one
// offset per period.
//
// Codex protocol contract (codex-rs/hooks/src/events/stop.rs):
//   - stdin: JSON { session_id, turn_id, transcript_path, cwd, model, ... }
//   - stdout: MUST be valid JSON (Codex rejects plain text). We always emit {}.
//   - exit code 0 on success; we always exit 0 (any error → silent {}).
//
// Completion feedback (when an earlier `pending` becomes `completed`) cannot
// surface via systemMessage like Claude — Codex Stop output is control-only.
// We write a short note to stderr (visible in Codex's session output / logs).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const DIR = path.join(CODEX_HOME, 'photosynth');
const CONFIG_PATH = path.join(DIR, 'config.json');
const STATE_PATH = path.join(DIR, 'state.json');

// Always emit `{}` on stdout and exit 0 — no matter what.
main()
  .catch(() => {})
  .finally(() => { try { process.stdout.write('{}'); } catch {} process.exit(0); });

async function main() {
  const input = readStdinJson();
  const config = readJson(CONFIG_PATH);
  if (!config || !config.wallet_address) return; // not configured → silent

  const state = readJson(STATE_PATH) || {};
  const now = new Date();
  const intervalSec = config.offset_interval_seconds ?? 86400;
  const period = periodInfo(now, intervalSec);

  // ① Result display: surface the outcome of the previous pending offset, once.
  if (state.pending && state.pending.shown !== true) {
    const res = await getStatus(config, state.pending.period);
    if (res && res.status === 'completed') {
      console.error(`🌱 Photosynth: offset completed ✅ retired ${fmtKwh(res.kwh)} of green energy on Arkreen.`);
      state.pending = null;
      writeJson(STATE_PATH, state);
    } else if (res && res.status === 'failed') {
      console.error(`🌱 Photosynth: offset for ${state.pending.period} failed after retries; will retry next period.`);
      state.pending = null;
      writeJson(STATE_PATH, state);
    }
    // pending / none / network failure → keep current state, retry on next Stop
  }

  // ② Periodic offset trigger (only if we haven't done it this period yet).
  if (state.last_offset_period !== period.key) {
    await maybeOffset(input, config, state, now, period);
  }
}

async function maybeOffset(input, config, state, now, period) {
  // Rate-limit: minimum interval between attempts (also bounds parser work).
  const minIntervalMs = (config.min_attempt_interval_seconds ?? 60) * 1000;
  if (state.last_attempt && now.getTime() - Date.parse(state.last_attempt) < minIntervalMs) return;
  state.last_attempt = now.toISOString();
  writeJson(STATE_PATH, state);

  const transcriptPath = input && input.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

  const stdinModel = (input && input.model) || 'codex-unknown';
  const { usageByModel, totalOutput, timeRange } = parseRolloutJsonl(transcriptPath, period.startMs, stdinModel);
  const minOut = config.min_output_tokens ?? 2000;
  if (totalOutput < minOut) return;

  const payload = {
    schema_version: config.schema_version ?? '1',
    wallet_address: config.wallet_address,
    local_date: period.key,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    request_id: crypto.randomUUID(),
    time_range: timeRange,
    usage_by_model: usageByModel,
    client: { plugin_version: config.plugin_version ?? '0.1.0', platform: 'codex-cli', cli_kind: 'codex' },
  };

  const res = await postOffset(config, payload);
  if (!res) return; // network failure → next interval will retry

  if (res.status === 'accepted' || res.status === 'duplicate') {
    state.last_offset_period = period.key;
    state.pending = { period: period.key, shown: false };
    writeJson(STATE_PATH, state);
    return;
  }
  if (res.status === 'disabled' || res.status === 'rejected') {
    state.last_offset_period = period.key; // back off for this period
    if (res.reason === 'upgrade_required' && !state.upgrade_notified) {
      state.upgrade_notified = true;
      console.error('🌱 Photosynth: a new client version is required; please update to continue offsetting.');
    }
    writeJson(STATE_PATH, state);
  }
}

// Parse the Codex session rollout JSONL.
// Each line is a serde-serialized RolloutItem. We look (defensively, since
// the exact serde tag layout may vary by version) for the per-turn token
// delta `last_token_usage` and sum it, filtered by best-effort timestamp.
//
// Reference: codex-rs/protocol/src/protocol.rs ::
//   pub struct TokenUsage {
//     pub input_tokens: i64,
//     pub cached_input_tokens: i64,
//     pub output_tokens: i64,
//     pub reasoning_output_tokens: i64,
//     pub total_tokens: i64,
//   }
//   pub struct TokenUsageInfo {
//     pub total_token_usage: TokenUsage,
//     pub last_token_usage: TokenUsage,
//     pub model_context_window: Option<i64>,
//   }
function parseRolloutJsonl(file, startMs, defaultModel) {
  const usageByModel = {};
  let totalOutput = 0;
  let minTs = null, maxTs = null;
  let currentModel = defaultModel;

  const data = fs.readFileSync(file, 'utf8');
  for (const raw of data.split('\n')) {
    if (!raw.trim()) continue;
    let obj;
    try { obj = JSON.parse(raw); } catch { continue; }

    // best-effort timestamp filter (period.startMs)
    const ts = extractTimestamp(obj);
    if (Number.isFinite(ts) && ts < startMs) continue;

    // track the latest model identifier seen (SessionMeta / TurnContext / …)
    const m = extractModel(obj);
    if (m) currentModel = m;

    const usage = extractLastTokenUsage(obj);
    if (!usage) continue;

    const model = currentModel || defaultModel;
    if (!usageByModel[model]) {
      usageByModel[model] = { output_tokens: 0, input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    }
    usageByModel[model].output_tokens += Number(usage.output_tokens) || 0;
    usageByModel[model].input_tokens += Number(usage.input_tokens) || 0;
    usageByModel[model].cache_read_input_tokens += Number(usage.cached_input_tokens) || 0; // Codex naming → Photosynth naming
    totalOutput += Number(usage.output_tokens) || 0;

    if (Number.isFinite(ts)) {
      if (minTs === null || ts < minTs) minTs = ts;
      if (maxTs === null || ts > maxTs) maxTs = ts;
    }
  }

  const timeRange = minTs !== null
    ? { start: new Date(minTs).toISOString(), end: new Date(maxTs).toISOString() }
    : null;
  return { usageByModel, totalOutput, timeRange };
}

function extractTimestamp(obj) {
  const candidates = [obj.timestamp, obj.ts, obj.time, obj.created_at, obj?.data?.timestamp];
  for (const c of candidates) {
    if (typeof c === 'string') { const t = Date.parse(c); if (Number.isFinite(t)) return t; }
    if (typeof c === 'number') return c > 1e12 ? c : c * 1000;
  }
  return NaN;
}

function extractModel(obj) {
  const places = [
    obj.model,
    obj?.data?.model,
    obj?.SessionMeta?.model,
    obj?.TurnContext?.model,
    obj?.session_meta?.model,
    obj?.turn_context?.model,
  ];
  for (const p of places) if (typeof p === 'string' && p.length) return p;
  return null;
}

function extractLastTokenUsage(obj) {
  // Try the layouts most likely emitted by serde for the RolloutItem enum.
  const candidates = [
    obj?.info?.last_token_usage,
    obj?.data?.info?.last_token_usage,
    obj?.EventMsg?.TokenCount?.info?.last_token_usage,
    obj?.event_msg?.token_count?.info?.last_token_usage,
    obj?.data?.TokenCount?.info?.last_token_usage,
    obj?.TokenCount?.info?.last_token_usage,
    obj?.payload?.info?.last_token_usage,
  ];
  for (const c of candidates) if (c && typeof c === 'object') return c;
  // Last-resort deep scan (bounded), so newer/older formats still work.
  return deepFindLastTokenUsage(obj, 6);
}

function deepFindLastTokenUsage(node, depth) {
  if (!node || typeof node !== 'object' || depth <= 0) return null;
  if (node.last_token_usage && typeof node.last_token_usage === 'object') return node.last_token_usage;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') {
      const r = deepFindLastTokenUsage(v, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

// ── network (identical to claude/kimi versions) ──

function getStatus(config, period) {
  return request(`${config.endpoint}/status?wallet=${encodeURIComponent(config.wallet_address)}&date=${encodeURIComponent(period)}`, { method: 'GET', headers: authHeader(config) });
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

// ── utils ──

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
  } catch {}
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
