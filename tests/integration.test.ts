import { test, expect, afterEach } from "bun:test";
import { writeFileSync } from "fs";
import path from "path";
import {
  createTestFile,
  spawnCLI,
  type SpawnedCLI,
  waitForServer,
  readResult,
  waitForExit,
} from "./helpers";

const procs: ReturnType<typeof Bun.spawn>[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) {
    try { p.kill(); } catch { /* already dead */ }
  }
});

async function spawnTracked(
  filePath: string,
  extraEnv: Record<string, string> = {}
): Promise<SpawnedCLI> {
  const result = await spawnCLI(filePath, extraEnv);
  procs.push(result.proc);
  return result;
}

// ── Tests ─────────────────────────────────────────────────────────────────

test("server starts on a free port, not 3000", async () => {
  const { filePath } = createTestFile();
  const { port } = await spawnTracked(filePath);
  expect(port).toBeGreaterThan(0);
  expect(port).not.toBe(3000);
}, 15_000);

// Note: SIGINT/SIGTERM signal handling is not testable via Bun.spawn's proc.kill() —
// the OS terminates the subprocess before the JS handler can run. Verified manually:
// Ctrl+C exits with code 2 and writes the abandoned result file correctly.
// The abandon() code path itself is exercised by the tab-close timer test below.

test("tab-close triggers abandon after grace period", async () => {
  const { filePath, dir } = createTestFile();
  const { proc, port } = await spawnTracked(filePath, { REDLINE_ABANDON_MS: "1000" });
  await waitForServer(port);

  // Connect as a browser client, then disconnect
  const ac = new AbortController();
  fetch(`http://localhost:${port}/api/events?client=browser`, {
    signal: ac.signal,
  }).catch(() => {});

  await Bun.sleep(200); // let connection register
  ac.abort();           // disconnect — triggers hadBrowser timer

  const code = await waitForExit(proc, 5000);

  expect(code).toBe(2);
  const result = await readResult(dir);
  expect(result.status).toBe("abandoned");
}, 15_000);

test("revision crash → abandon writes error result, not abandoned", async () => {
  const { filePath, dir } = createTestFile();
  const { proc, port } = await spawnTracked(filePath, { REDLINE_ABANDON_MS: "1000" });
  await waitForServer(port);

  // Simulate a revision crash: agent posts /api/revision-error with the failure reason.
  const errRes = await fetch(`http://localhost:${port}/api/revision-error`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "claude CLI exited with code 1 — boom" }),
  });
  expect(errRes.status).toBe(200);

  // Connect a browser then drop it, tripping the abandon timer.
  const ac = new AbortController();
  fetch(`http://localhost:${port}/api/events?client=browser`, { signal: ac.signal }).catch(() => {});
  await Bun.sleep(200);
  ac.abort();

  const code = await waitForExit(proc, 5000);
  expect(code).toBe(3);

  const result = await readResult(dir);
  expect(result.status).toBe("error");
  expect(result.reason).toContain("boom");
}, 15_000);

test("revision crash → recovered → abandon writes abandoned, not error", async () => {
  const { filePath, dir } = createTestFile();
  const { proc, port } = await spawnTracked(filePath, { REDLINE_ABANDON_MS: "1000" });
  await waitForServer(port);

  // Crash...
  await fetch(`http://localhost:${port}/api/revision-error`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "boom" }),
  });
  // ...then a successful revision lands (clears the error).
  await fetch(`http://localhost:${port}/api/reload`, { method: "POST" });

  const ac = new AbortController();
  fetch(`http://localhost:${port}/api/events?client=browser`, { signal: ac.signal }).catch(() => {});
  await Bun.sleep(200);
  ac.abort();

  const code = await waitForExit(proc, 5000);
  expect(code).toBe(2);
  const result = await readResult(dir);
  expect(result.status).toBe("abandoned");
}, 15_000);

test("brief disconnect-reconnect within grace does NOT trip abandon", async () => {
  const { filePath } = createTestFile();
  // 2s grace gives us a window to disconnect, reconnect, and outlast the original timer
  const { proc, port } = await spawnTracked(filePath, { REDLINE_ABANDON_MS: "2000" });
  await waitForServer(port);

  // First connection
  const ac1 = new AbortController();
  fetch(`http://localhost:${port}/api/events?client=browser`, { signal: ac1.signal }).catch(() => {});
  await Bun.sleep(200);

  // Drop it briefly — starts the abandon timer (2s)
  ac1.abort();
  await Bun.sleep(500);

  // Reconnect well within the grace — should cancel the timer
  const ac2 = new AbortController();
  fetch(`http://localhost:${port}/api/events?client=browser`, { signal: ac2.signal }).catch(() => {});
  await Bun.sleep(200);

  // Wait past the original 2s grace window. If the timer wasn't cancelled, the server would have exited.
  await Bun.sleep(2500);

  // Verify still alive: the HTTP endpoint responds.
  const res = await fetch(`http://localhost:${port}/api/comments`);
  expect(res.ok).toBe(true);

  // Cleanup
  ac2.abort();
}, 15_000);

test("agent auto-restarts when it dies unexpectedly", async () => {
  const { filePath, dir } = createTestFile();
  // The crash hook in agent.ts deletes the file on first run, so the *first*
  // spawn exits non-zero and the *second* (restart) starts cleanly.
  const crashFile = path.join(dir, "crash-trigger");
  writeFileSync(crashFile, "");

  const { port, waitForAgentConnects } = await spawnTracked(filePath, {
    REDLINE_AGENT_CRASH_FILE: crashFile,
  });
  await waitForServer(port);

  // Wait for the second agent connection — proves cli.ts spawned a fresh
  // agent after the first one exited via the crash hook.
  await waitForAgentConnects(2, 8000);
}, 15_000);

test("/api/finish writes approved result file and exits 0", async () => {
  const { filePath, dir } = createTestFile();
  const { proc, port } = await spawnTracked(filePath);
  await waitForServer(port);

  // Server auto-creates an open round on startup — /api/finish should work
  const res = await fetch(`http://localhost:${port}/api/finish`, { method: "POST" });
  expect(res.status).toBe(200);

  const code = await waitForExit(proc, 5000);

  expect(code).toBe(0);
  const result = await readResult(dir);
  expect(result.status).toBe("approved");
  expect(result.file).toBe(filePath);
  expect(typeof result.rounds).toBe("number");
  expect(typeof result.comments).toBe("number");
}, 15_000);
