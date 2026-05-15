#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, statSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import path from "path";
// reviewSummary only `import type`s from ./sidecar, so it pulls in no
// third-party deps at runtime — safe to import statically ahead of the
// preflight. abandon() needs it synchronously (signal context).
import { collectEscalations, formatReviewSummary } from "./reviewSummary";

// Ensure redline's own dependencies are resolvable before any third-party
// imports load. `redline` is invoked from arbitrary projects: in a checkout
// they sit in `<root>/node_modules`, but when installed from npm they're
// hoisted to the consumer's top-level `node_modules`. Use Node's standard
// module resolution so both layouts are handled.
//
// The auto-install fallback is for the checkout case (`git clone` + run
// without `bun install`). When already installed from a registry, deps are
// always resolvable and we never fall through to it.
function preflightDependencies() {
  const root = path.resolve(import.meta.dir, "..");
  const pkgPath = path.join(root, "package.json");
  // Compiled single-file binaries have no package.json next to the script —
  // skip the check entirely in that case.
  if (!existsSync(pkgPath)) return;
  let pkg: { dependencies?: Record<string, string> };
  try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch { return; }
  const deps = Object.keys(pkg.dependencies ?? {});
  const require = createRequire(pkgPath);
  const missing = deps.filter((d) => {
    try { require.resolve(d); return false; } catch { return true; }
  });
  if (missing.length === 0) return;
  console.log(`[redline] Dependencies missing from ${root}/node_modules: ${missing.join(", ")}`);
  console.log(`[redline] Running \`bun install\` in the redline checkout…`);
  const r = spawnSync("bun", ["install"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n[redline] \`bun install\` failed. Run it manually in ${root} and retry.`);
    process.exit(1);
  }
}
preflightDependencies();

// Dynamic imports so preflight runs before module resolution pulls in third-party deps.
const { createServer } = await import("./server");
const { resolve } = await import("./resolve");
const {
  getAgentProvider,
  invalidProviderMessage,
  parseAgentProviderId,
  resolveProviderId,
} = await import("./agentProvider");

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function selectProvider(args: string[]) {
  const raw = argValue(args, "--agent") ?? process.env.REDLINE_AGENT;
  if (raw && !parseAgentProviderId(raw)) {
    console.error(invalidProviderMessage(raw));
    process.exit(1);
  }
  return getAgentProvider(resolveProviderId(raw));
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

if (args[0] === "--version" || args[0] === "-v") {
  const pkgPath = path.resolve(import.meta.dir, "..", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    console.log(pkg.version ?? "unknown");
  } catch {
    console.log("unknown");
  }
  process.exit(0);
}

// redline install-skill [--agent claude|codex|both]
if (args[0] === "install-skill") {
  const script = path.resolve(import.meta.dir, "..", "scripts", "install-skill.sh");
  if (!existsSync(script)) {
    console.error(`Install script not found: ${script}`);
    process.exit(1);
  }
  const result = spawnSync("bash", [script, ...args.slice(1)], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

// redline resolve <file> [--model <id>]
if (args[0] === "resolve") {
  const filePath = args[1];
  if (!filePath) {
    console.error("Usage: redline resolve <file.md> [--model <model-id>] [--agent claude|codex]");
    process.exit(1);
  }
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }
  const model = argValue(args, "--model");
  const provider = selectProvider(args);
  try {
    provider.preflight();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  resolve(resolved, { model, agentProvider: provider.id });
} else {
  // redline <file>  — open review reader
  const filePath = args[0];
  if (!filePath) {
    console.error("Usage: redline <file.md>\n       redline resolve <file.md> [--model <model-id>] [--agent claude|codex]\n       redline install-skill [--agent claude|codex|both]");
    process.exit(1);
  }
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }
  const noAgent = args.includes("--no-agent");
  const provider = selectProvider(args);

  // Manual annotation mode skips both the preflight and the agent spawn —
  // the user just wants inline comments without an agent conversation, so
  // requiring a provider CLI on PATH would be a hostile gate.
  if (!noAgent) {
    try {
      provider.preflight();
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }

  const context = argValue(args, "--context");
  const autoOpen = args.includes("--open");

  const resultFile = path.join(path.dirname(resolved), ".review", path.basename(resolved) + ".result");
  const startupFile = path.join(path.dirname(resolved), ".review", path.basename(resolved) + ".startup.json");
  const sidecarFile = path.join(path.dirname(resolved), ".review", path.basename(resolved) + ".json");

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

  const app = createServer(resolved, { context, csrfToken, noAgent, agentName: provider.displayName });
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
      agent_provider: provider.id,
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
  if (noAgent) console.log(`  Mode: manual annotation (--no-agent — no ${provider.displayName} replies, no revision pass)`);
  if (!autoOpen) console.log(`\n  → cmd-click the URL when you're ready to review\n`);
  else console.log("");

  maybePrintGitignoreHint(resolved);

  // Auto-restart the agent if it dies unexpectedly (harness reaping, OOM,
  // a transient provider-CLI auth blip, etc). Capped to MAX_RESTARTS within
  // RESTART_WINDOW_MS so a permanently-broken environment doesn't loop forever.
  const RESTART_WINDOW_MS = 60_000;
  // Cap is overrideable via env so integration tests can exercise the
  // give-up path without spawning the agent six times.
  const MAX_RESTARTS = Number(process.env.REDLINE_MAX_RESTARTS ?? 5);
  const restartTimes: number[] = [];
  let agentProc: ReturnType<typeof Bun.spawn>;
  let serverExiting = false;

  function spawnAgent() {
    const proc = Bun.spawn(
      [process.execPath, "run", path.join(import.meta.dir, "agent.ts"), resolved],
      {
        stdout: "inherit", stderr: "inherit", stdin: "ignore",
        env: { ...process.env, REDLINE_PORT: String(server.port), REDLINE_TOKEN: csrfToken, REDLINE_AGENT: provider.id },
      }
    );
    agentProc = proc;
    proc.exited.then((code) => {
      if (serverExiting) return;
      if (code === 0) return;
      const now = Date.now();
      while (restartTimes.length && now - restartTimes[0] > RESTART_WINDOW_MS) restartTimes.shift();
      if (restartTimes.length >= MAX_RESTARTS) {
        const reason = `Agent crashed ${restartTimes.length}× in ${RESTART_WINDOW_MS / 1000}s — replies unavailable. Restart redline to recover.`;
        console.error(
          `\n[redline] ${reason} The review can still be completed manually. Check .review/errors.log.`
        );
        // Surface the dead-agent state to the browser so the user isn't left
        // wondering why replies stopped. Best-effort: server may already be down.
        fetch(`http://localhost:${server.port}/api/agent-unavailable`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Redline-Token": csrfToken },
          body: JSON.stringify({ reason }),
        }).catch(() => { /* server already gone */ });
        return;
      }
      restartTimes.push(now);
      console.error(
        `[redline] Agent exited unexpectedly (code ${code}) — restarting (${restartTimes.length}/${MAX_RESTARTS}).`
      );
      spawnAgent();
    });
  }
  if (!noAgent) spawnAgent();

  // Graceful shutdown: SIGTERM first so agent.ts can flush in-flight HTTP
  // posts and close its SSE connection cleanly, then SIGKILL after 2s if
  // the agent is still alive (broken handler, stuck syscall, etc.).
  // Async-aware version for the abandon/finish paths; the sync version
  // (`killAgentSync`) is used inside `process.on("exit")` where we can't await.
  const SHUTDOWN_GRACE_MS = 2000;
  async function killAgent() {
    if (!agentProc) return;
    try { agentProc.kill("SIGTERM"); } catch { return; /* already dead */ }
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
    await Promise.race([agentProc.exited.then(() => undefined), deadline]);
    if (agentProc && agentProc.exitCode === null) {
      try { agentProc.kill("SIGKILL"); } catch { /* already dead */ }
    }
  }
  function killAgentSync() {
    try { agentProc?.kill("SIGTERM"); } catch { /* already dead */ }
  }
  // Tracks the last unrecovered revision failure. If the session abandons while
  // this is set, the result file reports "error" instead of "abandoned" so a
  // calling agent can distinguish "user walked away" from "revision broke."
  let lastRevisionError: string | null = null;

  const abandon = () => {
    if (serverExiting) return;
    serverExiting = true;
    killAgent().catch(() => { /* shutdown already in flight */ });
    try { unlinkSync(startupFile); } catch { /* best effort */ }
    const status = lastRevisionError ? "error" : "abandoned";
    const payload: Record<string, unknown> = { status, file: resolved };
    if (lastRevisionError) payload.reason = lastRevisionError;
    // Carry escalations through the error/abandon path too — on an incomplete
    // session they matter more, not less. Read the sidecar synchronously:
    // abandon runs in signal context where async I/O may not complete.
    let escalations: import("./reviewSummary").EscalationItem[] = [];
    try {
      if (existsSync(sidecarFile)) {
        const raw = readFileSync(sidecarFile, "utf-8");
        if (raw.trim()) escalations = collectEscalations(JSON.parse(raw));
      }
    } catch { /* best effort — never block shutdown on the summary */ }
    payload.escalations = escalations;
    // Synchronous write so the result file lands even if the runtime is
    // terminating due to a signal (async I/O may not complete in that case).
    try {
      mkdirSync(path.dirname(resultFile), { recursive: true });
      writeFileSync(resultFile, JSON.stringify(payload, null, 2));
    } catch { /* best effort */ }
    if (escalations.length) {
      console.log(
        `\n⚠ ${escalations.length} comment${escalations.length !== 1 ? "s" : ""} escalated to the launching agent — see ${path.basename(resultFile)}`
      );
    }
    const escSuffix = escalations.length ? ` escalations=${escalations.length}` : "";
    console.log(`\nREDLINE_RESULT: ${status}${lastRevisionError ? ` reason="${lastRevisionError}"` : ""}${escSuffix}`);
    // Exit 3 = revision error; 2 = abandoned. Both still distinguish from 0 (approved).
    process.exit(lastRevisionError ? 3 : 2);
  };

  // Happy-path finish: human clicked Done.
  app.onFinished(async ({ totalRounds, totalComments }) => {
    serverExiting = true;
    killAgent().catch(() => { /* shutdown already in flight */ });
    try { unlinkSync(startupFile); } catch { /* best effort */ }
    const line = "─".repeat(60);
    console.log(`\n${line}`);
    console.log(`✓  Review complete — ${path.basename(resolved)}`);
    console.log(`   ${totalRounds} round${totalRounds !== 1 ? "s" : ""} · ${totalComments} comment${totalComments !== 1 ? "s" : ""} addressed`);
    console.log(`   Revised document: ${resolved}`);
    console.log(`${line}`);

    // Print the full comment threads so the launching agent — which has no
    // live channel to the inline review agent — sees everything the reviewer
    // said, including escalated feedback meant for it.
    let escalations: import("./reviewSummary").EscalationItem[] = [];
    try {
      const { loadSidecar } = await import("./sidecar");
      const sidecar = await loadSidecar(resolved);
      escalations = collectEscalations(sidecar);
      console.log(`\n${formatReviewSummary(sidecar)}`);
    } catch (e) {
      console.error("[redline] Failed to build review summary:", e);
    }

    // Machine-greppable result line for a calling agent. Keep this stable.
    const escSuffix = escalations.length ? ` escalations=${escalations.length}` : "";
    console.log(`\nREDLINE_RESULT: approved file=${resolved} rounds=${totalRounds} comments=${totalComments}${escSuffix}`);
    console.log("");
    writeResult({ status: "approved", file: resolved, rounds: totalRounds, comments: totalComments, escalations })
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

  process.on("exit", () => { serverExiting = true; killAgentSync(); });
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
