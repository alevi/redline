import { test, expect, afterEach } from "bun:test";
import {
  createTestFile,
  spawnCLI,
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
): Promise<{ proc: ReturnType<typeof Bun.spawn>; port: number }> {
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
