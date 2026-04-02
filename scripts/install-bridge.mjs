#!/usr/bin/env node
import { resolve, dirname } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const args = { mode: "project", target: undefined, skipOpenClaw: false, skipOpencode: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") args.mode = argv[++i] || args.mode;
    else if (arg === "--target") args.target = argv[++i];
    else if (arg === "--skip-openclaw") args.skipOpenClaw = true;
    else if (arg === "--skip-opencode") args.skipOpencode = true;
  }
  return args;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

const ENTRY_FILE_PATTERN = /\/index\.(?:[cm]?js|[cm]?ts)$/i;
const BUILD_ENTRY_FILE_PATTERN = /\/(?:dist|build|lib|out|src)(?:\/[^/]+)*\/index\.(?:[cm]?js|[cm]?ts)$/i;
const FORBIDDEN_OPENCLAW_LOCAL_INSTALL_PATTERN = /\/dist\/src\/index\.(?:[cm]?js|[cm]?ts)$/i;

function assertAllowedTargetPath(targetPath) {
  const normalized = resolve(targetPath).replaceAll("\\", "/");
  const isEntrypointLike = ENTRY_FILE_PATTERN.test(normalized) && BUILD_ENTRY_FILE_PATTERN.test(normalized);
  const isKnownBadInstallPath = FORBIDDEN_OPENCLAW_LOCAL_INSTALL_PATTERN.test(normalized);
  if (!isEntrypointLike && !isKnownBadInstallPath) return;

  console.error(
    [
      "Forbidden install target: do not pass plugin entry files (for example dist/src/index.js) to install flow.",
      "Why: OpenClaw local installs infer plugin key from basename, so index.js becomes plugin id 'index'.",
      "Use plugin root/repo root instead:",
      "  openclaw plugins install -l <repo-root>",
      "or use canonical bridge install:",
      "  npm run install:bridge:project",
    ].join("\n"),
  );
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const target = args.target ? resolve(args.target) : process.cwd();

if (args.target) {
  assertAllowedTargetPath(target);
}

if (!args.skipOpenClaw) {
  run("openclaw", ["plugins", "install", "-l", repoRoot]);
}

if (!args.skipOpencode) {
  const materializeArgs = [resolve(repoRoot, "scripts", "materialize-opencode-plugin.mjs"), "--mode", args.mode];
  if (args.mode === "project") {
    materializeArgs.push("--target", target);
  } else if (args.target) {
    materializeArgs.push("--target", target);
  }
  run("node", materializeArgs, { cwd: repoRoot });
}

const summary = {
  ok: true,
  mode: args.mode,
  repoRoot,
  target,
  steps: {
    openclawInstalled: !args.skipOpenClaw,
    opencodeMaterialized: !args.skipOpencode,
  },
  note: args.mode === "global"
    ? "Global mode installed OpenClaw plugin locally and materialized OpenCode plugin into global config dir."
    : "Project mode installed OpenClaw plugin locally and materialized OpenCode plugin into the target project's .opencode directory.",
};
console.log(JSON.stringify(summary, null, 2));
