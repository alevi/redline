#!/usr/bin/env node
// Node-compatible launcher so `npx @levistudio/redline <file>` works even when the
// caller doesn't have Bun on PATH yet. Bun is still required at runtime — the
// server is `Bun.serve()` — but we surface the missing-Bun case as one clean
// message rather than an opaque shebang/parse failure.
//
// On `bunx @levistudio/redline`, this file is also the entry point; it just finds
// the same Bun that ran it and re-execs `bun run src/cli.ts`. No-op for the
// caller, single code path for us.
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CLI = path.resolve(__dirname, "..", "src", "cli.ts");

function findBun() {
  if (process.env.BUN_INSTALL_BIN) {
    const candidate = path.join(
      process.env.BUN_INSTALL_BIN,
      process.platform === "win32" ? "bun.exe" : "bun",
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  const probe = spawnSync(
    process.platform === "win32" ? "where" : "which",
    ["bun"],
    { encoding: "utf8" },
  );
  if (probe.status === 0 && probe.stdout) {
    const first = probe.stdout.split(/\r?\n/)[0].trim();
    if (first) return first;
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    const fallback = path.join(
      home,
      ".bun",
      "bin",
      process.platform === "win32" ? "bun.exe" : "bun",
    );
    if (fs.existsSync(fallback)) return fallback;
  }
  return null;
}

const bun = findBun();
if (!bun) {
  process.stderr.write(
    "\nRedline requires Bun. Install it and re-run:\n" +
      "  https://bun.sh\n\n" +
      "Then: bunx @levistudio/redline <file.md>   (or rerun the same npx command)\n\n",
  );
  process.exit(1);
}

const child = spawn(bun, ["run", CLI, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, REDLINE_BIN_ABS: __filename },
});
child.on("exit", (code, signal) => {
  if (signal) {
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exit(1);
    }
  } else {
    process.exit(code == null ? 0 : code);
  }
});
child.on("error", (err) => {
  process.stderr.write(`\n[redline] Failed to launch bun: ${err.message}\n`);
  process.exit(1);
});
