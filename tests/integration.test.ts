import { test, expect, afterEach } from "bun:test";
import { writeFileSync, existsSync, readFileSync } from "fs";
import path from "path";
import os from "os";
import {
  createTestFile,
  spawnCLI,
  type SpawnedCLI,
  waitForServer,
  readResult,
  waitForExit,
  TEST_CSRF_TOKEN,
} from "./helpers";

const CSRF_HEADERS = { "X-Redline-Token": TEST_CSRF_TOKEN };
const CSRF_JSON_HEADERS = { "Content-Type": "application/json", "X-Redline-Token": TEST_CSRF_TOKEN };

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

test("mutating /api requests are rejected without X-Redline-Token", async () => {
  const { filePath } = createTestFile();
  const { port } = await spawnTracked(filePath);

  // No header: expect 403. Defends against a malicious page in another tab
  // firing no-cors POSTs at the loopback server.
  const noHeader = await fetch(`http://localhost:${port}/api/comment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quote: "test", context_before: "", context_after: "", message: "x" }),
  });
  expect(noHeader.status).toBe(403);

  // Wrong header value: also 403.
  const wrongHeader = await fetch(`http://localhost:${port}/api/comment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Redline-Token": "not-the-real-one" },
    body: JSON.stringify({ quote: "test", context_before: "", context_after: "", message: "x" }),
  });
  expect(wrongHeader.status).toBe(403);

  // Correct header: 200. Confirms the test fixture token is valid end-to-end.
  const ok = await fetch(`http://localhost:${port}/api/comment`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({ quote: "test", context_before: "", context_after: "", message: "x" }),
  });
  expect(ok.status).toBe(200);

  // GETs are not gated — reading state was never the CSRF concern.
  const readOk = await fetch(`http://localhost:${port}/api/comments`);
  expect(readOk.ok).toBe(true);
}, 15_000);

test("server binds to loopback only, not all interfaces", async () => {
  const { filePath } = createTestFile();
  const { port } = await spawnTracked(filePath);

  // Loopback must work — that's the whole point of the tool.
  const loopback = await fetch(`http://127.0.0.1:${port}/`);
  expect(loopback.status).toBeLessThan(500);

  // Find a non-loopback IPv4 interface. Most dev machines and CI runners
  // have one (en0, eth0, etc.). If we somehow don't, the assertion below
  // is vacuous but the loopback assertion above is still meaningful.
  const externalIp = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

  if (externalIp) {
    let refused = false;
    try {
      await fetch(`http://${externalIp}:${port}/`, {
        signal: AbortSignal.timeout(1500),
      });
    } catch {
      // ECONNREFUSED, timeout, or any other failure to reach the port from
      // a non-loopback interface is the success signal. Binding to 0.0.0.0
      // would have made this fetch succeed.
      refused = true;
    }
    expect(refused).toBe(true);
  }
}, 15_000);

test("startup file appears with URL the moment the server is listening", async () => {
  // The skill's invocation flow polls for this file to extract the URL —
  // the Bash-tool stdout buffering means a calling agent can't read the URL
  // banner until the process exits, so the startup file is the only race-free
  // way for the agent to surface the URL to the human while the session runs.
  const { filePath, dir } = createTestFile();
  const { port } = await spawnTracked(filePath);

  const startupPath = path.join(dir, ".review", path.basename(filePath) + ".startup.json");

  // Helper-promise resolves once spawnCLI sees the URL on stdout, so the
  // startup file must already exist by that point. Any later wait is belt-and-
  // suspenders against a race in the cli.ts ordering.
  expect(existsSync(startupPath)).toBe(true);
  const data = JSON.parse(readFileSync(startupPath, "utf-8"));

  expect(data.url).toBe(`http://localhost:${port}`);
  expect(data.port).toBe(port);
  expect(data.file).toBe(filePath);
  expect(typeof data.pid).toBe("number");
  expect(typeof data.started_at).toBe("string");
  expect(data.result_file).toBe(path.join(dir, ".review", path.basename(filePath) + ".result"));
}, 15_000);

test("startup file is removed on abandon so a stale one can't fool the next run", async () => {
  const { filePath, dir } = createTestFile();
  const { proc, port } = await spawnTracked(filePath, { REDLINE_ABANDON_MS: "1000" });
  await waitForServer(port);

  const startupPath = path.join(dir, ".review", path.basename(filePath) + ".startup.json");
  expect(existsSync(startupPath)).toBe(true);

  // Trip the abandon timer the same way the tab-close test does.
  const ac = new AbortController();
  fetch(`http://localhost:${port}/api/events?client=browser`, { signal: ac.signal }).catch(() => {});
  await Bun.sleep(200);
  ac.abort();

  await waitForExit(proc, 5000);
  expect(existsSync(startupPath)).toBe(false);
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
    headers: CSRF_JSON_HEADERS,
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
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({ message: "boom" }),
  });
  // ...then a successful revision lands (clears the error).
  await fetch(`http://localhost:${port}/api/reload`, { method: "POST", headers: CSRF_HEADERS });

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

test("two concurrent CLIs both write result files under simultaneous SIGTERM", async () => {
  // Investigation #5: two sister Redlines under one harness both "crashed" in
  // M4 testing. Reproduced as harness-style PGID sharing — the result files
  // do land cleanly under SIGTERM thanks to the M3 synchronous writeFileSync
  // path, even with two signals delivered at once. This codifies that.
  const a = createTestFile();
  const b = createTestFile();
  const [sa, sb] = await Promise.all([spawnTracked(a.filePath), spawnTracked(b.filePath)]);
  await Promise.all([waitForServer(sa.port), waitForServer(sb.port)]);

  // Fire both SIGTERMs as close to simultaneous as the runtime allows.
  process.kill(sa.proc.pid!, "SIGTERM");
  process.kill(sb.proc.pid!, "SIGTERM");

  const [aCode, bCode] = await Promise.all([waitForExit(sa.proc, 5000), waitForExit(sb.proc, 5000)]);
  expect(aCode).toBe(2);
  expect(bCode).toBe(2);

  const [aRes, bRes] = await Promise.all([readResult(a.dir), readResult(b.dir)]);
  expect(aRes.status).toBe("abandoned");
  expect(bRes.status).toBe("abandoned");
}, 20_000);

test("/api/finish writes approved result file and exits 0", async () => {
  const { filePath, dir } = createTestFile();
  const { proc, port } = await spawnTracked(filePath);
  await waitForServer(port);

  // Server auto-creates an open round on startup — /api/finish should work
  const res = await fetch(`http://localhost:${port}/api/finish`, { method: "POST", headers: CSRF_HEADERS });
  expect(res.status).toBe(200);

  const code = await waitForExit(proc, 5000);

  expect(code).toBe(0);
  const result = await readResult(dir);
  expect(result.status).toBe("approved");
  expect(result.file).toBe(filePath);
  expect(typeof result.rounds).toBe("number");
  expect(typeof result.comments).toBe("number");
}, 15_000);
