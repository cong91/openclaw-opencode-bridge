#!/usr/bin/env node
import { mkdirSync, copyFileSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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

const pluginDir = args.mode === "global"
  ? join(targetBase, "plugins")
  : join(targetBase, ".opencode", "plugins");
const targetFile = join(pluginDir, "openclaw-bridge-callback.js");

mkdirSync(pluginDir, { recursive: true });
copyFileSync(pluginArtifact, targetFile);

let configUpdate = { updated: false, reason: "not_requested" };
if (args.mode === "global") {
  const configPath = join(targetBase, "opencode.json");
  configUpdate = ensurePluginEntry(configPath, "./plugins/openclaw-bridge-callback.js");
} else {
  const configPath = join(targetBase, ".opencode", "opencode.json");
  configUpdate = ensurePluginEntry(configPath, "./plugins/openclaw-bridge-callback.js");
}

console.log(JSON.stringify({
  ok: true,
  mode: args.mode,
  sourceFile: pluginArtifact,
  targetFile,
  configUpdate,
  note: args.mode === "global"
    ? "Copy complete. Global OpenCode config was auto-patched when present."
    : "Copy complete. Project-local .opencode/opencode.json was updated when present.",
}, null, 2));
