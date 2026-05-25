#!/usr/bin/env node
// Photosynth —— Claude Code `Stop` hook。
// 每次 Claude 响应结束时触发，承担两件事：
//   ① 同步并展示上一次 offset 的结果（只在本地有 pending 时才查服务端）；
//   ② 每个周期一次：解析本周期 token 用量，向后台发起 offset 请求。
//      周期由 config.offset_interval_seconds 决定（默认 86400=每天；测试可设 3600=每小时）。
//
// 设计原则：
//   - 失败一律静默退出（exit 0），绝不阻塞用户、绝不刷错误。
//   - 绝大多数 Stop（本周期已 offset、无 pending）走零成本短路：读两个小文件即退。
//   - 仅依赖 Node 内置模块，跨平台（Claude Code 自带 Node）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

const DIR = path.join(os.homedir(), '.claude', 'photosynth');
const CONFIG_PATH = path.join(DIR, 'config.json');
const STATE_PATH = path.join(DIR, 'state.json');

// 任何未捕获异常都静默退出，绝不影响用户会话。
main().catch(() => process.exit(0));

async function main() {
  const input = readStdinJson();
  const config = readJson(CONFIG_PATH);
  if (!config || !config.wallet_address) process.exit(0); // 未配置 → 静默退出

  const state = readJson(STATE_PATH) || {};
  const now = new Date();
  const intervalSec = config.offset_interval_seconds ?? 86400;
  const period = periodInfo(now, intervalSec); // { key, startMs }

  let systemMessage = null;

  // ── ① 结果展示（与周期 offset 解耦；仅在有未展示的 pending 时查询）──
  if (state.pending && state.pending.shown !== true) {
    const res = await getStatus(config, state.pending.period);
    if (res && res.status === 'completed') {
      systemMessage = `🌱 Photosynth：offset 完成 ✅ 已为你 retire ${fmtKwh(res.kwh)} 绿电（Arkreen）。`;
      state.pending = null;
      writeJson(STATE_PATH, state);
    } else if (res && res.status === 'failed') {
      systemMessage = `🌱 Photosynth：${state.pending.period} 的 offset 多次重试后失败，已放弃；下个周期再试。`;
      state.pending = null;
      writeJson(STATE_PATH, state);
    }
    // pending / none / 网络失败 → 保持现状，下次 Stop 再查
  }

  // ── ② 周期 offset 触发（本周期没做过才进入）──
  if (state.last_offset_period !== period.key) {
    const m = await maybeOffset(input, config, state, now, period);
    if (m && !systemMessage) systemMessage = m;
  }

  if (systemMessage) process.stdout.write(JSON.stringify({ systemMessage }));
  process.exit(0);
}

async function maybeOffset(input, config, state, now, period) {
  // 限频：两次尝试至少间隔 N 秒。既避免"未达阈值反复解析大 transcript"，
  // 也兼作"网络失败后的重试间隔"。
  const minIntervalMs = (config.min_attempt_interval_seconds ?? 60) * 1000;
  if (state.last_attempt && now.getTime() - Date.parse(state.last_attempt) < minIntervalMs) return;
  state.last_attempt = now.toISOString();
  writeJson(STATE_PATH, state);

  const transcriptPath = input && input.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

  const { usageByModel, totalOutput, timeRange } = parseTranscript(transcriptPath, period.startMs);
  const minOut = config.min_output_tokens ?? 2000;
  if (totalOutput < minOut) return; // 未达阈值 → 本周期静默跳过，下个间隔再判

  const payload = {
    schema_version: config.schema_version ?? '1',
    wallet_address: config.wallet_address,
    local_date: period.key, // 周期标识，同时作为服务端幂等键
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    request_id: crypto.randomUUID(),
    time_range: timeRange,
    usage_by_model: usageByModel,
    client: { plugin_version: config.plugin_version ?? '0.1.0' },
  };

  const res = await postOffset(config, payload);
  if (!res) return null; // 网络失败 → 不设 last_offset_period，下个间隔自动重试（服务端按 wallet+周期 幂等）

  if (res.status === 'accepted' || res.status === 'duplicate') {
    state.last_offset_period = period.key;
    state.pending = { period: period.key, shown: false };
    writeJson(STATE_PATH, state);
    return null;
  }
  if (res.status === 'disabled') {
    // 活动暂停/结束：本周期不再尝试
    state.last_offset_period = period.key;
    writeJson(STATE_PATH, state);
    return null;
  }
  if (res.status === 'rejected') {
    // 未授权 / 需升级 / 超额等：本周期退避，不再每个间隔反复 hammer
    state.last_offset_period = period.key;
    if (res.reason === 'upgrade_required' && !state.upgrade_notified) {
      state.upgrade_notified = true;
      writeJson(STATE_PATH, state);
      return '🌱 Photosynth：检测到新版本要求，请更新后再继续 offset。';
    }
    writeJson(STATE_PATH, state);
    return null;
  }
  return null; // 未知状态：保守不改，下个间隔再试
}

// 解析 transcript JSONL，按 per-model 汇总"本周期内（timestamp >= startMs）"的 token 用量。
function parseTranscript(file, startMs) {
  const usageByModel = {};
  let totalOutput = 0;
  let minTs = null, maxTs = null;

  const data = fs.readFileSync(file, 'utf8');
  for (const line of data.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== 'assistant' || !obj.message) continue;

    const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    if (!Number.isFinite(ts) || ts < startMs) continue; // 仅计入本周期

    const u = obj.message.usage || {};
    const model = obj.message.model || 'unknown';
    if (!usageByModel[model]) {
      usageByModel[model] = {
        output_tokens: 0, input_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      };
    }
    usageByModel[model].output_tokens += u.output_tokens || 0;
    usageByModel[model].input_tokens += u.input_tokens || 0;
    usageByModel[model].cache_read_input_tokens += u.cache_read_input_tokens || 0;
    usageByModel[model].cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    totalOutput += u.output_tokens || 0;

    if (minTs === null || ts < minTs) minTs = ts;
    if (maxTs === null || ts > maxTs) maxTs = ts;
  }

  const timeRange = minTs !== null
    ? { start: new Date(minTs).toISOString(), end: new Date(maxTs).toISOString() }
    : null;
  return { usageByModel, totalOutput, timeRange };
}

// ── 网络（HTTP）──

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

// 极简 HTTP 客户端：任何错误/超时都 resolve(null)，由调用方静默处理。
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

// ── 工具 ──

function readStdinJson() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return {}; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// 原子写：先写临时文件再 rename，避免并发写坏。
function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* 静默 */ }
}

// 按 offset_interval_seconds 对齐到本地零点切桶。
// 返回 { key, startMs }：key 既是人类可读的周期标识，也用作服务端幂等键与状态查询键。
//   每天(86400) → 2026-05-25 ；每小时(3600) → 2026-05-25-14 ；更短 → 2026-05-25-1430
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
