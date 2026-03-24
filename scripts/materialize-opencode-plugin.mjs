#!/usr/bin/env node
import { mkdirSync, copyFileSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const args = { mode: "project", target: undefined, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") args.mode = argv[++i] || args.mode;
    else if (arg === "--target") args.target = argv[++i];
    else if (arg === "--force") args.force = true;
  }
  return args;
}

function ensurePluginEntry(configPath, pluginRef) {
  if (!existsSync(configPath)) return { updated: false, reason: "missing_config" };
  const raw = readFileSync(configPath, "utf8");
  const data = JSON.parse(raw);
  const plugins = Array.isArray(data.plugin) ? data.plugin : [];
  if (!plugins.includes(pluginRef)) {
    data.plugin = [...plugins, pluginRef];
    writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    return { updated: true, reason: "added_plugin_ref" };
  }
  return { updated: false, reason: "already_present" };
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const pluginArtifact = join(repoRoot, "dist", "opencode-plugin", "openclaw-bridge-callback.js");
const sharedChunkArtifact = join(repoRoot, "dist", "chunk-TDVN5AFB.js");
if (!existsSync(pluginArtifact)) {
  console.error(`Missing built plugin artifact: ${pluginArtifact}. Run npm run build first.`);
  process.exit(1);
}
if (!existsSync(sharedChunkArtifact)) {
  console.error(`Missing shared chunk artifact: ${sharedChunkArtifact}. Run npm run build first.`);
  process.exit(1);
}

const targetBase = args.target
  ? resolve(args.target)
  : args.mode === "global"
    ? resolve(process.env.HOME || "~", ".config", "opencode")
    : repoRoot;

const pluginBaseDir = args.mode === "global"
  ? join(targetBase, "plugins", "openclaw-bridge")
  : join(targetBase, ".opencode", "plugins", "openclaw-bridge");
const targetFile = join(pluginBaseDir, "openclaw-bridge-callback.js");

mkdirSync(pluginBaseDir, { recursive: true });
copyFileSync(pluginArtifact, targetFile);

// Best-effort cleanup of previous flat layout files.
const legacyFlatPlugin = args.mode === "global"
  ? join(targetBase, "plugins", "openclaw-bridge-callback.js")
  : join(targetBase, ".opencode", "plugins", "openclaw-bridge-callback.js");
if (existsSync(legacyFlatPlugin)) {
  try { rmSync(legacyFlatPlugin, { force: true }); } catch {}
}
const legacyFlatConfig = args.mode === "global"
  ? join(targetBase, "plugins", "openclaw-bridge-callback.config.json")
  : join(targetBase, ".opencode", "plugins", "openclaw-bridge-callback.config.json");
if (existsSync(legacyFlatConfig)) {
  try { rmSync(legacyFlatConfig, { force: true }); } catch {}
}

let configUpdate = { updated: false, reason: "not_requested" };
if (args.mode === "global") {
  const configPath = join(targetBase, "opencode.json");
  configUpdate = ensurePluginEntry(configPath, "./plugins/openclaw-bridge/openclaw-bridge-callback.js");
} else {
  const configPath = join(targetBase, ".opencode", "opencode.json");
  configUpdate = ensurePluginEntry(configPath, "./plugins/openclaw-bridge/openclaw-bridge-callback.js");
}

const syncScript = join(repoRoot, 'scripts', 'sync-opencode-plugin-config.mjs');
const { spawnSync } = await import('node:child_process');
const syncArgs = [syncScript, '--mode', args.mode];
if (args.target) syncArgs.push('--target', resolve(args.target));
const sync = spawnSync('node', syncArgs, { cwd: repoRoot, encoding: 'utf8' });
if (sync.status !== 0) {
  console.error(sync.stderr || sync.stdout || 'Failed to persist plugin config');
  process.exit(sync.status || 1);
}
let syncResult = null;
try { syncResult = JSON.parse(sync.stdout); } catch {}

console.log(JSON.stringify({
  ok: true,
  mode: args.mode,
  sourceFile: pluginArtifact,
  targetFile,
  configUpdate,
  persistedPluginConfig: syncResult,
  note: args.mode === "global"
    ? "Copy complete. Global OpenCode config now points to ./plugins/openclaw-bridge/openclaw-bridge-callback.js. Plugin-owned config lives under ~/.config/opencode/plugins/openclaw-bridge/."
    : "Copy complete. Project-local OpenCode config now points to ./plugins/openclaw-bridge/openclaw-bridge-callback.js. Plugin-owned config lives under .opencode/plugins/openclaw-bridge/.",
}, null, 2));
