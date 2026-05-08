#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, statSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { createServer } from "./server";
import { resolve } from "./resolve";

// Verify the `claude` CLI is reachable before we start, so first-run users
// without Claude Code installed get a clear message instead of a silent agent
// crash later (the agent process shells out to `claude -p`; without it, replies
// fail and errors land in `.review/errors.log` where nobody looks).
//
// Resolution mirrors the runtime: prefer CLAUDE_CODE_EXECPATH (used by tests
// and advanced setups), then look for `claude` on PATH.
function preflightClaudeCli() {
  const exec = process.env.CLAUDE_CODE_EXECPATH;
  if (exec && existsSync(exec)) return;
  if (Bun.which("claude")) return;
  console.error(
    "\n[redline] Could not find the `claude` CLI on PATH.\n" +
    "Redline shells out to Claude Code for agent replies and revisions.\n" +
    "Install it from https://claude.com/claude-code and re-run.\n"
  );
  process.exit(1);
}

// Walk up from `start` looking for a git root (a `.git` directory or file —
// worktrees use a file). Returns the directory containing it, or null.
function findGitRoot(start: string): string | null {
  let dir = start;
  while (true) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// If the file lives inside a git repo and `.review/` isn't already ignored,
// print a one-line hint. We don't edit .gitignore — just nudge.
function maybePrintGitignoreHint(filePath: string) {
  const root = findGitRoot(path.dirname(filePath));
  if (!root) return;
  const gitignorePath = path.join(root, ".gitignore");
  let contents = "";
  try {
    if (existsSync(gitignorePath) && statSync(gitignorePath).isFile()) {
      contents = readFileSync(gitignorePath, "utf-8");
    }
  } catch { /* unreadable — fall through and hint */ }
  const lines = contents.split("\n").map((l) => l.trim());
  const ignored = lines.some((l) =>
    l === ".review" || l === ".review/" || l === "**/.review" || l === "**/.review/"
  );
  if (ignored) return;
  console.log(`\n  Tip: redline writes to .review/ next to your file. Add this to ${path.relative(process.cwd(), gitignorePath) || ".gitignore"} to keep it out of git:`);
  console.log(`    .review/`);
}

const args = process.argv.slice(2);

// redline resolve <file> [--model <id>]
if (args[0] === "resolve") {
  const filePath = args[1];
  if (!filePath) {
    console.error("Usage: redline resolve <file.md> [--model <model-id>]");
    process.exit(1);
  }
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }
  const modelFlag = args.indexOf("--model");
  const model = modelFlag !== -1 ? args[modelFlag + 1] : undefined;
  preflightClaudeCli();
  resolve(resolved, { model });
} else {
  // redline <file>  — open review reader
  const filePath = args[0];
  if (!filePath) {
    console.error("Usage: redline <file.md>");
    process.exit(1);
  }
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }
  preflightClaudeCli();

  const contextFlag = args.indexOf("--context");
  const context = contextFlag !== -1 ? args[contextFlag + 1] : undefined;
  const autoOpen = args.includes("--open");

  const resultFile = path.join(path.dirname(resolved), ".review", path.basename(resolved) + ".result");
  const startupFile = path.join(path.dirname(resolved), ".review", path.basename(resolved) + ".startup.json");

  // Clear stale state from a prior run so a polling agent can't be misled
  // by a leftover .result or .startup.json file that predates this process.
  for (const f of [resultFile, startupFile]) {
    try { unlinkSync(f); } catch { /* not present is fine */ }
  }

  async function writeResult(payload: Record<string, unknown>) {
    try {
      await mkdir(path.dirname(resultFile), { recursive: true });
      await writeFile(resultFile, JSON.stringify(payload, null, 2), "utf-8");
    } catch (e) {
      console.error("[redline] Failed to write result file:", e);
    }
  }

  // CSRF token threaded through to: createServer (mints from this), the agent
  // subprocess (via REDLINE_TOKEN env), and startup.json (so a calling skill
  // or test runner can read it). `REDLINE_TOKEN` from env wins so an outer
  // caller can pin the token if it needs to.
  const csrfToken = process.env.REDLINE_TOKEN ?? crypto.randomUUID();

  const app = createServer(resolved, { context, csrfToken });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 0 });
  const url = `http://localhost:${server.port}`;

  // Surface the URL to a calling agent that can't read this process's stdout.
  // (Bash with timeout buffers stdout until the process exits — for blocking
  // invocations the agent would otherwise never see the URL until the human
  // clicked Done. Polling this file gives a deterministic, race-free signal.)
  try {
    mkdirSync(path.dirname(startupFile), { recursive: true });
    writeFileSync(startupFile, JSON.stringify({
      url,
      port: server.port,
      file: resolved,
      result_file: resultFile,
      started_at: new Date().toISOString(),
      pid: process.pid,
      csrf_token: csrfToken,
    }, null, 2));
  } catch (e) {
    console.error("[redline] Failed to write startup file:", e);
  }

  const bar = "─".repeat(60);
  console.log(`\n${bar}`);
  console.log(`Redline review session`);
  console.log(`  File: ${resolved}`);
  console.log(`  URL:  ${url}`);
  console.log(`  Result: ${resultFile}`);
  console.log(`${bar}`);
  if (!autoOpen) console.log(`\n  → cmd-click the URL when you're ready to review\n`);
  else console.log("");

  maybePrintGitignoreHint(resolved);

  // Auto-restart the agent if it dies unexpectedly (harness reaping, OOM,
  // a transient claude-CLI auth blip, etc). Capped to MAX_RESTARTS within
  // RESTART_WINDOW_MS so a permanently-broken environment doesn't loop forever.
  const RESTART_WINDOW_MS = 60_000;
  const MAX_RESTARTS = 5;
  const restartTimes: number[] = [];
  let agentProc: ReturnType<typeof Bun.spawn>;
  let serverExiting = false;

  function spawnAgent() {
    const proc = Bun.spawn(
      [process.execPath, "run", path.join(import.meta.dir, "agent.ts"), resolved],
      {
        stdout: "inherit", stderr: "inherit", stdin: "ignore",
        env: { ...process.env, REDLINE_PORT: String(server.port), REDLINE_TOKEN: csrfToken },
      }
    );
    agentProc = proc;
    proc.exited.then((code) => {
      if (serverExiting) return;
      if (code === 0) return;
      const now = Date.now();
      while (restartTimes.length && now - restartTimes[0] > RESTART_WINDOW_MS) restartTimes.shift();
      if (restartTimes.length >= MAX_RESTARTS) {
        console.error(
          `\n[redline] Agent crashed ${restartTimes.length}× in ${RESTART_WINDOW_MS / 1000}s — giving up. ` +
          `Comment replies are unavailable; the review can still be completed manually. Check .review/errors.log.`
        );
        return;
      }
      restartTimes.push(now);
      console.error(
        `[redline] Agent exited unexpectedly (code ${code}) — restarting (${restartTimes.length}/${MAX_RESTARTS}).`
      );
      spawnAgent();
    });
  }
  spawnAgent();
  const killAgent = () => { try { agentProc?.kill(); } catch { /* already dead */ } };
  // Tracks the last unrecovered revision failure. If the session abandons while
  // this is set, the result file reports "error" instead of "abandoned" so a
  // calling agent can distinguish "user walked away" from "revision broke."
  let lastRevisionError: string | null = null;

  const abandon = () => {
    if (serverExiting) return;
    serverExiting = true;
    killAgent();
    try { unlinkSync(startupFile); } catch { /* best effort */ }
    const status = lastRevisionError ? "error" : "abandoned";
    const payload: Record<string, unknown> = { status, file: resolved };
    if (lastRevisionError) payload.reason = lastRevisionError;
    // Synchronous write so the result file lands even if the runtime is
    // terminating due to a signal (async I/O may not complete in that case).
    try {
      mkdirSync(path.dirname(resultFile), { recursive: true });
      writeFileSync(resultFile, JSON.stringify(payload, null, 2));
    } catch { /* best effort */ }
    console.log(`\nREDLINE_RESULT: ${status}${lastRevisionError ? ` reason="${lastRevisionError}"` : ""}`);
    // Exit 3 = revision error; 2 = abandoned. Both still distinguish from 0 (approved).
    process.exit(lastRevisionError ? 3 : 2);
  };

  // Happy-path finish: human clicked Done.
  app.onFinished(({ totalRounds, totalComments }) => {
    serverExiting = true;
    killAgent();
    try { unlinkSync(startupFile); } catch { /* best effort */ }
    const line = "─".repeat(60);
    console.log(`\n${line}`);
    console.log(`✓  Review complete — ${path.basename(resolved)}`);
    console.log(`   ${totalRounds} round${totalRounds !== 1 ? "s" : ""} · ${totalComments} comment${totalComments !== 1 ? "s" : ""} addressed`);
    console.log(`   Revised document: ${resolved}`);
    console.log(`${line}`);
    // Machine-greppable result line for a calling agent. Keep this stable.
    console.log(`REDLINE_RESULT: approved file=${resolved} rounds=${totalRounds} comments=${totalComments}`);
    console.log("");
    writeResult({ status: "approved", file: resolved, rounds: totalRounds, comments: totalComments })
      .finally(() => process.exit(0));
  });

  // Tab-close abandonment: if no browser reconnects within the abandon grace, exit cleanly.
  app.onAbandon(abandon);

  // Track revision-error state so a session that abandons after a broken revision
  // exits with status: "error" rather than "abandoned".
  app.onRevisionError((message) => {
    lastRevisionError = message;
    console.error(`[redline] Revision failed: ${message}`);
  });
  app.onRevisionRecovered(() => {
    if (lastRevisionError) console.log("[redline] Revision-error state cleared.");
    lastRevisionError = null;
  });

  process.on("exit", () => { serverExiting = true; killAgent(); });
  // SIGINT/SIGTERM = abandoned session. Exit 2 so a calling agent can
  // distinguish "user gave up" from "user clicked Done" (exit 0).
  process.on("SIGINT", abandon);
  process.on("SIGTERM", abandon);

  if (autoOpen) {
    const open =
      process.platform === "darwin" ? "open" :
      process.platform === "win32"  ? "start" : "xdg-open";
    Bun.spawn([open, url]);
  }
}
