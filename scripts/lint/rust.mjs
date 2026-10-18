#!/usr/bin/env node
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { ROOT, RUST_TARGET_DIR, TOOLING_ROOT, pinnedRustToolchain } from "./scope.mjs";

const TOOLCHAIN = pinnedRustToolchain();
const WASM_TARGET = "wasm32-unknown-unknown";
const LINT_ARGS = ["--message-format", "short", "--", "-D", "warnings"];
const LOCKED_ARGS = ["--locked", "--no-deps"];
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
const USAGE = `Usage:
  node scripts/lint/rust.mjs format --check
  node scripts/lint/rust.mjs format --write
  node scripts/lint/rust.mjs lint
`;
const PACKAGE_SPECS = [
  {
    name: "kitesurf-core",
    path: "packages/core",
    hostTargets: "all",
    wasmCwd: "member",
  },
  {
    name: "renderer-core",
    path: "packages/renderer-core",
    hostTargets: "lib",
    wasmCwd: "member",
  },
  {
    name: "scene-host-wasm",
    path: "packages/scene-host-wasm",
    hostTargets: "lib",
    wasmCwd: "root",
    wasmRustflags: "-C target-feature=+simd128",
  },
  {
    name: "comparison-core",
    path: "packages/comparison-core",
    hostTargets: "all",
    wasmCwd: "root",
    wasmRustflags: "-C target-feature=+simd128,+bulk-memory,+nontrapping-fptoint,+sign-ext",
    standalone: true,
  },
  {
    name: "boa-bench",
    path: "packages/boa-bench",
    hostTargets: "all",
    wasmCwd: "member",
    wasmFeatures: [null, "alloc-stats"],
    standalone: true,
  },
];
const SIMPLE_MANIFESTS = [
  { label: "packages/kitesurf-cli", path: "packages/kitesurf-cli/Cargo.toml" },
  { label: "scripts/memprof-rewriter", path: "scripts/memprof-rewriter/Cargo.toml" },
  {
    label: "scripts/lint/rust-check",
    path: resolve(TOOLING_ROOT, "scripts/lint/rust-check/Cargo.toml"),
  },
];
let activeChild = null;
let receivedSignal = null;

for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
  process.on(signal, () => {
    receivedSignal ??= signal;
    process.exitCode = SIGNAL_EXIT_CODES[receivedSignal] ?? 1;
    if (activeChild !== null && activeChild.exitCode === null && activeChild.signalCode === null) {
      activeChild.kill(signal);
    }
  });
}

function parseMode(args) {
  if (args.length === 1 && ["-h", "--help"].includes(args[0])) return "help";
  if (args.length === 2 && args[0] === "format" && args[1] === "--check") {
    return "format-check";
  }
  if (args.length === 2 && args[0] === "format" && args[1] === "--write") {
    return "format-write";
  }
  if (args.length === 1 && args[0] === "lint") return "lint";
  return null;
}

function cargoEnvironment(rustflags) {
  const env = {
    ...process.env,
    PATH: [resolve(process.env.HOME || homedir(), ".cargo/bin"), process.env.PATH]
      .filter(Boolean)
      .join(delimiter),
    CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || "2",
    CARGO_TARGET_DIR: RUST_TARGET_DIR,
  };

  delete env.CARGO_BUILD_TARGET;
  delete env.CARGO_ENCODED_RUSTFLAGS;
  delete env.RUSTFLAGS;
  if (rustflags !== undefined) env.RUSTFLAGS = rustflags;
  return env;
}

function rootWorkspaceMembers() {
  const manifestPath = resolve(ROOT, "Cargo.toml");
  if (!existsSync(manifestPath)) return null;

  const source = readFileSync(manifestPath, "utf8");
  const workspaceHeader = /^\[workspace\]\s*$/mu.exec(source);
  if (workspaceHeader === null || workspaceHeader.index === undefined) return null;

  const sectionStart = workspaceHeader.index + workspaceHeader[0].length;
  const remaining = source.slice(sectionStart);
  const nextSection = /^\s*\[[^\]]+\]\s*$/mu.exec(remaining);
  const section =
    nextSection?.index === undefined ? remaining : remaining.slice(0, nextSection.index);
  const memberList = /^\s*members\s*=\s*\[([\s\S]*?)\]/mu.exec(section)?.[1];
  if (memberList === undefined) return [];

  return [...memberList.matchAll(/"([^"]+)"/gu)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

function workspaceMemberMatches(pattern, candidate) {
  let source = "^";
  for (let offset = 0; offset < pattern.length; offset++) {
    const character = pattern[offset];
    if (character === "*" && pattern[offset + 1] === "*") {
      source += ".*";
      offset++;
    } else if (character === "*") {
      source += "[^/]*";
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "u").test(candidate);
}

function selectPackages() {
  const members = rootWorkspaceMembers();
  const workspace = [];
  const standalone = [];

  for (const spec of PACKAGE_SPECS) {
    const manifest = resolve(ROOT, spec.path, "Cargo.toml");
    if (!existsSync(manifest)) continue;

    const isMember =
      members?.some((pattern) => workspaceMemberMatches(pattern, spec.path)) ?? false;
    if (isMember) {
      workspace.push(spec);
    } else if (spec.standalone === true) {
      standalone.push({ ...spec, manifest });
    }
  }

  return { workspace, standalone };
}

function standaloneManifests() {
  return SIMPLE_MANIFESTS.flatMap(({ label, path }) => {
    const manifest = path.startsWith("/") ? path : resolve(ROOT, path);
    if (!existsSync(manifest)) return [];
    return [{ label, manifest, cwd: dirname(manifest) }];
  });
}

function formatCommands(check, selected) {
  const checkArgs = check ? ["--check"] : [];
  const commands = [];
  if (selected.workspace.length > 0) {
    commands.push({
      label: "root workspace packages",
      cwd: ROOT,
      args: [
        "fmt",
        ...selected.workspace.flatMap(({ name }) => ["--package", name]),
        "--manifest-path",
        "Cargo.toml",
        ...checkArgs,
      ],
    });
  }

  const manifests = [
    ...selected.standalone.map(({ path, manifest }) => ({
      label: path,
      manifest,
      cwd: resolve(ROOT, path),
    })),
    ...standaloneManifests(),
  ];
  for (const { label, manifest, cwd } of manifests) {
    commands.push({
      label: `standalone ${label}`,
      cwd,
      args: ["fmt", "--manifest-path", manifest, ...checkArgs],
    });
  }
  return commands;
}

function hostLintArgs(hostTargets, manifest, packageName) {
  return [
    "clippy",
    "--manifest-path",
    manifest,
    ...(packageName === undefined ? [] : ["--package", packageName]),
    ...(hostTargets === "lib" ? ["--lib"] : ["--all-targets"]),
    ...LOCKED_ARGS,
    ...LINT_ARGS,
  ];
}

function wasmLintArgs(manifest, packageName, feature) {
  return [
    "clippy",
    "--manifest-path",
    manifest,
    ...(packageName === undefined ? [] : ["--package", packageName]),
    ...(feature === null ? [] : ["--features", feature]),
    "--lib",
    "--release",
    "--target",
    WASM_TARGET,
    ...LOCKED_ARGS,
    ...LINT_ARGS,
  ];
}

function lintCommands(selected) {
  const hostCommands = selected.workspace.map((spec) => ({
    label: `host ${spec.path} (${spec.hostTargets === "lib" ? "library" : "all targets"})`,
    cwd: ROOT,
    args: hostLintArgs(spec.hostTargets, "Cargo.toml", spec.name),
  }));
  for (const { label, manifest, cwd } of standaloneManifests()) {
    hostCommands.push({
      label: `host ${label} (all targets)`,
      cwd,
      args: hostLintArgs("all", manifest),
    });
  }
  for (const spec of selected.standalone) {
    hostCommands.push({
      label: `host ${spec.path} (all targets)`,
      cwd: resolve(ROOT, spec.path),
      args: hostLintArgs("all", spec.manifest),
    });
  }

  const wasmCommands = [];
  for (const spec of selected.workspace) {
    const cwd = spec.wasmCwd === "member" ? resolve(ROOT, spec.path) : ROOT;
    const manifest = "Cargo.toml";
    const packageName = spec.wasmCwd === "member" ? undefined : spec.name;
    const features = spec.wasmFeatures ?? [null];
    for (const feature of features) {
      wasmCommands.push({
        label: `wasm ${spec.path}${feature === null ? "" : ` (${feature})`}`,
        cwd,
        args: wasmLintArgs(manifest, packageName, feature),
        ...(spec.wasmRustflags === undefined ? {} : { rustflags: spec.wasmRustflags }),
      });
    }
  }
  for (const spec of selected.standalone) {
    const cwd = spec.wasmCwd === "member" ? resolve(ROOT, spec.path) : ROOT;
    const features = spec.wasmFeatures ?? [null];
    for (const feature of features) {
      wasmCommands.push({
        label: `wasm ${spec.path}${feature === null ? "" : ` (${feature})`}`,
        cwd,
        args: wasmLintArgs(spec.manifest, undefined, feature),
        ...(spec.wasmRustflags === undefined ? {} : { rustflags: spec.wasmRustflags }),
      });
    }
  }

  return [...hostCommands, ...wasmCommands];
}

function runChild(program, args, cwd, rustflags) {
  const command = JSON.stringify([program, ...args]);
  process.stdout.write(`[rust] ${command}\n[rust] cwd: ${cwd}\n`);
  if (receivedSignal !== null) {
    return Promise.resolve({ command, cwd, status: null, signal: receivedSignal });
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(program, args, {
      cwd,
      env: cargoEnvironment(rustflags),
      stdio: "inherit",
    });
    activeChild = child;
    child.once("error", (error) => {
      if (activeChild === child) activeChild = null;
      rejectPromise(new Error(`Could not start ${command} in ${cwd}: ${error.message}`));
    });
    child.once("close", (status, signal) => {
      if (activeChild === child) activeChild = null;
      resolvePromise({ command, cwd, status, signal });
    });
  });
}

async function runCommands(commands, operation) {
  const failures = [];
  for (const { label, cwd, args, rustflags } of commands) {
    if (receivedSignal !== null) break;
    process.stdout.write(`[rust] ${operation}: ${label}\n`);
    const result = await runChild("rustup", ["run", TOOLCHAIN, "cargo", ...args], cwd, rustflags);
    if (result.status !== 0 || result.signal !== null) {
      failures.push({ ...result, label });
      const outcome = result.signal ? `signal ${result.signal}` : `exit status ${result.status}`;
      process.stderr.write(`[rust] ${label} failed with ${outcome}\n`);
    }
  }

  if (failures.length > 0) {
    process.stderr.write(`[rust] ${failures.length} ${operation} command(s) failed\n`);
    for (const failure of failures) {
      process.stderr.write(
        `[rust] ${failure.label}: ${failure.command} (cwd ${failure.cwd}, ` +
          `${failure.signal ? `signal ${failure.signal}` : `status ${failure.status}`})\n`,
      );
    }
    process.exitCode =
      failures[0].status ??
      (failures[0].signal === null ? 1 : (SIGNAL_EXIT_CODES[failures[0].signal] ?? 1));
  }
  if (receivedSignal !== null) process.exitCode = SIGNAL_EXIT_CODES[receivedSignal] ?? 1;
}

async function materializeVendorSources() {
  const manifestPath = resolve(ROOT, "Cargo.toml");
  const script = resolve(ROOT, "scripts/get-patched-vendor-crates.mjs");
  if (
    !existsSync(manifestPath) ||
    !existsSync(script) ||
    !/^\[patch\.crates-io\]\s*$/mu.test(readFileSync(manifestPath, "utf8"))
  ) {
    return true;
  }

  const result = await runChild(process.execPath, [script], ROOT);
  if (result.status !== 0 || result.signal !== null) {
    const outcome = result.signal ? `signal ${result.signal}` : `exit status ${result.status}`;
    process.stderr.write(`[rust] vendor materialization failed with ${outcome}\n`);
    process.exitCode =
      receivedSignal === null
        ? (result.status ?? (result.signal === null ? 1 : (SIGNAL_EXIT_CODES[result.signal] ?? 1)))
        : (SIGNAL_EXIT_CODES[receivedSignal] ?? 1);
    return false;
  }
  return true;
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  if (mode === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (mode === null) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  if (mode === "lint" && !(await materializeVendorSources())) return;
  const selected = selectPackages();
  if (mode === "lint") {
    await runCommands(lintCommands(selected), "Clippy");
    return;
  }
  await runCommands(formatCommands(mode === "format-check", selected), "rustfmt");
}

main().catch((error) => {
  process.stderr.write(`[rust] ${error.stack ?? error.message}\n`);
  process.exitCode = receivedSignal === null ? 1 : (SIGNAL_EXIT_CODES[receivedSignal] ?? 1);
});
