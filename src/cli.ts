#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { createServer } from "./server";
import { resolve } from "./resolve";

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

  const contextFlag = args.indexOf("--context");
  const context = contextFlag !== -1 ? args[contextFlag + 1] : undefined;

  const resultFile = path.join(path.dirname(resolved), ".review", path.basename(resolved) + ".result");

  async function writeResult(payload: Record<string, unknown>) {
    try {
      await mkdir(path.dirname(resultFile), { recursive: true });
      await writeFile(resultFile, JSON.stringify(payload, null, 2), "utf-8");
    } catch (e) {
      console.error("[redline] Failed to write result file:", e);
    }
  }

  const app = createServer(resolved, { context });
  const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 0 });
  const url = `http://localhost:${server.port}`;
  const bar = "─".repeat(60);
  console.log(`\n${bar}`);
  console.log(`Redline review session`);
  console.log(`  File: ${resolved}`);
  console.log(`  URL:  ${url}    ← open here if you lose the tab`);
  console.log(`  Result: ${resultFile}`);
  console.log(`${bar}\n`);

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
        env: { ...process.env, REDLINE_PORT: String(server.port) },
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

  if (!process.env.REDLINE_NO_OPEN) {
    const open =
      process.platform === "darwin" ? "open" :
      process.platform === "win32"  ? "start" : "xdg-open";
    Bun.spawn([open, url]);
  }
}
