#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const args = { mode: 'project', target: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode') args.mode = argv[++i] || args.mode;
    else if (arg === '--target') args.target = argv[++i];
  }
  return args;
}

function readBridgeConfig() {
  const stateDir = process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
  const path = join(stateDir, 'opencode-bridge', 'config.json');
  if (!existsSync(path)) return { path, data: {} };
  try {
    return { path, data: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { path, data: {} };
  }
}

const args = parseArgs(process.argv.slice(2));
const targetBase = args.target
  ? resolve(args.target)
  : args.mode === 'global'
    ? resolve(process.env.HOME || '~', '.config', 'opencode')
    : process.cwd();

const { path: bridgeConfigPath, data: bridgeCfg } = readBridgeConfig();
const pluginBaseDir = args.mode === 'global'
  ? join(targetBase, 'plugins', 'openclaw-bridge')
  : join(targetBase, '.opencode', 'plugins', 'openclaw-bridge');
const outPath = join(pluginBaseDir, 'config.json');
mkdirSync(dirname(outPath), { recursive: true });

const configPayload = {
  hookBaseUrl: bridgeCfg.hookBaseUrl || '',
  hookToken: bridgeCfg.hookToken || '',
  openclawAuditPath: resolve(process.env.HOME || '~', '.openclaw', 'opencode-bridge', 'audit', 'callbacks.jsonl'),
  auditDir: args.mode === 'global'
    ? resolve(process.env.HOME || '~', '.config', 'opencode', 'plugins', 'openclaw-bridge')
    : join(targetBase, '.opencode'),
};
writeFileSync(outPath, JSON.stringify(configPayload, null, 2) + '\n', 'utf8');

// Best-effort cleanup legacy flat config path.
const legacyFlatConfig = args.mode === 'global'
  ? join(targetBase, 'plugins', 'openclaw-bridge-callback.config.json')
  : join(targetBase, '.opencode', 'plugins', 'openclaw-bridge-callback.config.json');
if (existsSync(legacyFlatConfig)) {
  try { rmSync(legacyFlatConfig, { force: true }); } catch {}
}

const suggest = [];
if (!bridgeCfg.hookBaseUrl) suggest.push('Set hookBaseUrl in ~/.openclaw/opencode-bridge/config.json');
if (!bridgeCfg.hookToken) suggest.push('Set hookToken in ~/.openclaw/opencode-bridge/config.json');
suggest.push(args.mode === 'global'
  ? 'Suggested plugin entry in ~/.config/opencode/opencode.json: { "plugin": ["./plugins/openclaw-bridge/openclaw-bridge-callback.js"] }'
  : 'Suggested plugin entry in .opencode/opencode.json: { "plugin": ["./plugins/openclaw-bridge/openclaw-bridge-callback.js"] }');

console.log(JSON.stringify({
  ok: true,
  mode: args.mode,
  bridgeConfigPath,
  outPath,
  wrote: true,
  note: 'Persisted OpenClaw callback config under plugin-owned namespace. Env is fallback only.',
  suggest,
}, null, 2));
