import { test, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { readFile } from "fs/promises";
import { mkdtempSync } from "fs";
import path from "path";
import os from "os";

const CLI = path.join(import.meta.dir, "../src/cli.ts");
const BUN = process.execPath;

// Shared env for all test spawns: suppress browser open, short Claude timeout
const TEST_ENV = {
  ...process.env,
  REDLINE_NO_OPEN: "1",
};

// Track spawned processes so afterEach can always clean up
const procs: ReturnType<typeof Bun.spawn>[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) {
    try { p.kill(); } catch { /* already dead */ }
  }
});

function createTestFile(): { filePath: string; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "redline-test-"));
  const filePath = path.join(dir, "test.md");
  writeFileSync(filePath, "# Test Document\n\nThis is a test.\n");
  return { filePath, dir };
}

async function spawnCLI(
  filePath: string,
  extraEnv: Record<string, string> = {}
): Promise<{ proc: ReturnType<typeof Bun.spawn>; port: number }> {
  const proc = Bun.spawn([BUN, "run", CLI, filePath], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...TEST_ENV, ...extraEnv },
  });
  procs.push(proc);

  // Read stdout until we find the URL line, then extract the port
  const port = await Promise.race([
    readPortFromStdout(proc.stdout),
    Bun.sleep(10_000).then(() => { throw new Error("CLI did not print URL within 10s"); }),
  ]);
  return { proc, port };
}

async function readPortFromStdout(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("stdout closed before URL appeared");
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/URL:\s+http:\/\/localhost:(\d+)/);
      if (m) return parseInt(m[1], 10);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function waitForServer(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error(`Server on port ${port} did not become ready within ${timeoutMs}ms`);
}

async function readResult(dir: string): Promise<Record<string, unknown>> {
  const p = path.join(dir, ".review", "test.md.result");
  const raw = await readFile(p, "utf-8");
  return JSON.parse(raw);
}

async function waitForExit(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = 5000
): Promise<number> {
  return Promise.race([
    proc.exited,
    Bun.sleep(timeoutMs).then(() => { throw new Error(`Process did not exit within ${timeoutMs}ms`); }),
  ]);
}

// ── Tests ─────────────────────────────────────────────────────────────────

test("server starts on a free port, not 3000", async () => {
  const { filePath } = createTestFile();
  const { port } = await spawnCLI(filePath);
  expect(port).toBeGreaterThan(0);
  expect(port).not.toBe(3000);
}, 15_000);

// Note: SIGINT/SIGTERM signal handling is not testable via Bun.spawn's proc.kill() —
// the OS terminates the subprocess before the JS handler can run. Verified manually:
// Ctrl+C exits with code 2 and writes the abandoned result file correctly.
// The abandon() code path itself is exercised by the tab-close timer test below.

test("tab-close triggers abandon after grace period", async () => {
  const { filePath, dir } = createTestFile();
  const { proc, port } = await spawnCLI(filePath, { REDLINE_ABANDON_MS: "1000" });
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
  const { proc, port } = await spawnCLI(filePath);
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
