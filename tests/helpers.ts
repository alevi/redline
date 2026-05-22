import { mkdtempSync, writeFileSync, chmodSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";
import os from "os";

/**
 * Write a shim wrapper script in the test's tmp dir that invokes the claude
 * shim via `bun`. Returns an absolute path suitable for CLAUDE_CODE_EXECPATH.
 * Needed because the agent/resolve code does `spawn(cliBin, ...)` directly,
 * and the shim's `#!/usr/bin/env bun` shebang fails when bun isn't on PATH.
 */
export function installClaudeShim(dir: string): string {
  const shimPath = path.resolve(import.meta.dir, "fixtures", "claude-shim.ts");
  const wrapper = path.join(dir, "claude");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${process.execPath} ${shimPath} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

export function installCodexShim(dir: string): string {
  const shimPath = path.resolve(import.meta.dir, "fixtures", "codex-shim.ts");
  const wrapper = path.join(dir, "codex");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${process.execPath} ${shimPath} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

export const CLI = path.join(import.meta.dir, "../src/cli.ts");
export const BUN = process.execPath;

// Pinned token across all spawned CLIs so tests can sign their POSTs without
// reading startup.json on every call. Production code still mints a random
// UUID per server when REDLINE_TOKEN isn't set.
export const TEST_CSRF_TOKEN = "test-token-fixed-for-the-suite";

export const TEST_ENV = {
  ...process.env,
  REDLINE_TOKEN: TEST_CSRF_TOKEN,
};

/** Wrap fetch to attach X-Redline-Token on mutating tests. */
export function mut(
  port: number,
  urlPath: string,
  init: RequestInit = {},
): Promise<Response> {
  const m = (init.method || "GET").toUpperCase();
  if (m === "GET" || m === "HEAD")
    return fetch(`http://localhost:${port}${urlPath}`, init);
  const headers: Record<string, string> = {
    "X-Redline-Token": TEST_CSRF_TOKEN,
  };
  if (init.headers)
    Object.assign(headers, init.headers as Record<string, string>);
  return fetch(`http://localhost:${port}${urlPath}`, { ...init, headers });
}

export function createTestFile(
  content = "# Test Document\n\nThis is a test.\n",
): {
  filePath: string;
  dir: string;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "redline-test-"));
  const filePath = path.join(dir, "test.md");
  writeFileSync(filePath, content);
  return { filePath, dir };
}

export type SpawnedCLI = {
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
  agentReady: Promise<void>;
  /** Resolves when the Nth `[agent] connected` line appears on stdout. */
  waitForAgentConnects: (n: number, timeoutMs?: number) => Promise<void>;
};

export async function spawnCLI(
  filePath: string,
  extraEnv: Record<string, string> = {},
  extraArgs: string[] = [],
): Promise<SpawnedCLI> {
  const proc = Bun.spawn([BUN, "run", CLI, filePath, ...extraArgs], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...TEST_ENV, ...extraEnv },
  });

  // The agent inherits stdout/stderr from the CLI. We need to keep both pipes
  // drained for the lifetime of the spawn, AND watch the stream for two
  // markers: the "URL:" line (which gives us the port) and "[agent] connected"
  // (which tells us the agent has subscribed to /api/events and won't miss the
  // first broadcast).
  let resolvePort!: (n: number) => void;
  let rejectPort!: (e: unknown) => void;
  const portP = new Promise<number>((res, rej) => {
    resolvePort = res;
    rejectPort = rej;
  });

  // Track every `[agent] connected` occurrence so tests can wait for restarts.
  let agentConnects = 0;
  type Waiter = {
    n: number;
    resolve: () => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  const waiters: Waiter[] = [];
  const onAgentConnect = () => {
    agentConnects += 1;
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].n <= agentConnects) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve();
        waiters.splice(i, 1);
      }
    }
  };

  let resolveAgent!: () => void;
  const agentReady = new Promise<void>((res) => {
    resolveAgent = res;
  });

  watchStdout(proc.stdout, {
    onPort: resolvePort,
    onAgentConnect: () => {
      onAgentConnect();
      resolveAgent();
    },
    onError: rejectPort,
  });
  drainStream(proc.stderr);

  const port = await Promise.race([
    portP,
    Bun.sleep(10_000).then(() => {
      throw new Error("CLI did not print URL within 10s");
    }),
  ]);

  const waitForAgentConnects = (n: number, timeoutMs = 10_000) =>
    new Promise<void>((resolve, reject) => {
      if (agentConnects >= n) return resolve();
      const timer = setTimeout(() => {
        const idx = waiters.findIndex(
          (w) => w.n === n && w.resolve === resolve,
        );
        if (idx !== -1) waiters.splice(idx, 1);
        reject(
          new Error(
            `Timed out waiting for ${n}th [agent] connected (saw ${agentConnects})`,
          ),
        );
      }, timeoutMs);
      waiters.push({ n, resolve, reject, timer });
    });

  return { proc, port, agentReady, waitForAgentConnects };
}

async function watchStdout(
  stream: ReadableStream<Uint8Array>,
  cb: {
    onPort: (n: number) => void;
    onAgentConnect: () => void;
    onError: (e: unknown) => void;
  },
): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let portSeen = false;
  // Track the consumed offset so each "[agent] connected" line fires exactly
  // once per occurrence (a single read can deliver multiple lines and a later
  // read can deliver another connect after a restart).
  let consumed = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (!portSeen)
          cb.onError(new Error("stdout closed before URL appeared"));
        return;
      }
      buf += dec.decode(value, { stream: true });
      if (!portSeen) {
        const m = buf.match(/URL:\s+http:\/\/localhost:(\d+)/);
        if (m) {
          portSeen = true;
          cb.onPort(parseInt(m[1], 10));
        }
      }
      // Scan for new "[agent] connected" occurrences past the last consumed offset.
      let idx;
      while ((idx = buf.indexOf("[agent] connected", consumed)) !== -1) {
        consumed = idx + "[agent] connected".length;
        cb.onAgentConnect();
      }
      // Trim buffer so it doesn't grow without bound, but preserve enough tail
      // that a partially-buffered marker can complete on the next read.
      if (buf.length > 16384) {
        const drop = buf.length - 1024;
        buf = buf.slice(drop);
        consumed = Math.max(0, consumed - drop);
      }
    }
  } catch (e) {
    if (!portSeen) cb.onError(e);
  }
}

function drainStream(stream: ReadableStream<Uint8Array>): void {
  // Best-effort drain — ignore errors so cleanup of dead processes is silent.
  (async () => {
    try {
      const reader = stream.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) return;
      }
    } catch {
      /* stream closed or already locked */
    }
  })();
}

export async function waitForServer(
  port: number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `Server on port ${port} did not become ready within ${timeoutMs}ms`,
  );
}

export async function readResult(
  dir: string,
): Promise<Record<string, unknown>> {
  const p = path.join(dir, ".review", "test.md.result");
  const raw = await readFile(p, "utf-8");
  return JSON.parse(raw);
}

export async function waitForExit(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = 5000,
): Promise<number> {
  return Promise.race([
    proc.exited,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`Process did not exit within ${timeoutMs}ms`);
    }),
  ]);
}

/** Spawn a server, wait for readiness, return port + cleanup function. */
export async function startServer(
  filePath: string,
  extraEnv: Record<string, string> = {},
): Promise<{
  port: number;
  proc: ReturnType<typeof Bun.spawn>;
  stop: () => void;
}> {
  const { proc, port } = await spawnCLI(filePath, extraEnv);
  await waitForServer(port);
  return {
    port,
    proc,
    stop: () => {
      try {
        proc.kill();
      } catch {}
    },
  };
}

export type SseEvent = { event: string; data: any };

/**
 * Subscribe to /api/events and resolve on the first frame matching `eventName`
 * (and optionally `predicate`). Pattern:
 *
 *   const ev = waitForEvent(port, "X");
 *   await ev.ready;            // SSE handshake complete; safe to trigger
 *   await fetch(...);          // do the action
 *   const data = await ev;     // event guaranteed not missed
 *
 * Awaiting `ev.ready` before triggering the action is what closes the race:
 * the server's broadcast loop only sees the new client once `: connected` has
 * been written, so without the ready-await an early action's broadcast can
 * fire before the test's controller is registered.
 */
export function waitForEvent(
  port: number,
  eventName: string,
  options: {
    client?: string;
    timeoutMs?: number;
    predicate?: (data: any) => boolean;
  } = {},
): Promise<SseEvent> & { stop: () => void; ready: Promise<void> } {
  const { client = "test", timeoutMs = 3000, predicate } = options;
  const ac = new AbortController();
  let stopped = false;
  const stop = () => {
    stopped = true;
    try {
      ac.abort();
    } catch {}
  };

  let resolveReady: () => void;
  const ready = new Promise<void>((res) => {
    resolveReady = res;
  });

  const promise = (async (): Promise<SseEvent> => {
    const res = await fetch(
      `http://localhost:${port}/api/events?client=${client}`,
      {
        signal: ac.signal,
      },
    );
    if (!res.body) throw new Error("SSE stream has no body");

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let signaledReady = false;

    // Timeout aborts the fetch so a stuck read can unblock. The catch below
    // converts the resulting AbortError into the expected "Timed out" message
    // — distinct from natural completion (event found) where we do NOT abort.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        ac.abort();
      } catch {}
    }, timeoutMs);

    let foundEvent: SseEvent | undefined;
    try {
      while (!stopped && foundEvent === undefined) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (e: any) {
          if (timedOut || e?.name === "AbortError") {
            throw new Error(`Timed out waiting for SSE event "${eventName}"`);
          }
          throw e;
        }
        if (chunk.done) {
          if (timedOut)
            throw new Error(`Timed out waiting for SSE event "${eventName}"`);
          throw new Error("SSE stream closed before event arrived");
        }
        buf += dec.decode(chunk.value, { stream: true });

        // SSE frames are separated by a blank line
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          // Skip comment frames (": connected", ": ping"). The first comment
          // frame doubles as the "you're connected" signal.
          if (frame.startsWith(":")) {
            if (!signaledReady) {
              signaledReady = true;
              resolveReady();
            }
            continue;
          }
          if (!signaledReady) {
            signaledReady = true;
            resolveReady();
          }
          const lines = frame.split("\n");
          let evType = "message";
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("event:")) evType = line.slice(6).trim();
            else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
          }
          if (evType !== eventName) continue;
          let data: any = null;
          try {
            data = dataStr ? JSON.parse(dataStr) : null;
          } catch {
            /* not json */
          }
          if (predicate && !predicate(data)) continue;
          foundEvent = { event: evType, data };
          break;
        }
      }
      if (foundEvent) return foundEvent;
      throw new Error("Stopped before event arrived");
    } finally {
      clearTimeout(timer);
      // Cancel the reader cleanly (no abort) so we don't surface a stray
      // AbortError when we already have the result.
      reader.cancel().catch(() => {});
      stopped = true;
    }
  })();

  return Object.assign(promise, { stop, ready });
}

/** POST a comment and return the created comment object. */
export async function postComment(
  port: number,
  selection: { quote: string; context_before?: string; context_after?: string },
  message: string,
): Promise<{ id: string; quote: string; thread: any[]; resolved: boolean }> {
  const res = await fetch(`http://localhost:${port}/api/comment`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Redline-Token": TEST_CSRF_TOKEN,
    },
    body: JSON.stringify({
      quote: selection.quote,
      context_before: selection.context_before ?? "",
      context_after: selection.context_after ?? "",
      message,
    }),
  });
  if (!res.ok) throw new Error(`POST /api/comment failed: ${res.status}`);
  const data = await res.json();
  return data.comment;
}
