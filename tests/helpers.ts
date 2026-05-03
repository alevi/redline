import { mkdtempSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";
import os from "os";

export const CLI = path.join(import.meta.dir, "../src/cli.ts");
export const BUN = process.execPath;

export const TEST_ENV = {
  ...process.env,
  REDLINE_NO_OPEN: "1",
};

export function createTestFile(content = "# Test Document\n\nThis is a test.\n"): {
  filePath: string;
  dir: string;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "redline-test-"));
  const filePath = path.join(dir, "test.md");
  writeFileSync(filePath, content);
  return { filePath, dir };
}

export async function spawnCLI(
  filePath: string,
  extraEnv: Record<string, string> = {}
): Promise<{ proc: ReturnType<typeof Bun.spawn>; port: number }> {
  const proc = Bun.spawn([BUN, "run", CLI, filePath], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...TEST_ENV, ...extraEnv },
  });

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

export async function waitForServer(port: number, timeoutMs = 5000): Promise<void> {
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

export async function readResult(dir: string): Promise<Record<string, unknown>> {
  const p = path.join(dir, ".review", "test.md.result");
  const raw = await readFile(p, "utf-8");
  return JSON.parse(raw);
}

export async function waitForExit(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = 5000
): Promise<number> {
  return Promise.race([
    proc.exited,
    Bun.sleep(timeoutMs).then(() => { throw new Error(`Process did not exit within ${timeoutMs}ms`); }),
  ]);
}

/** Spawn a server, wait for readiness, return port + cleanup function. */
export async function startServer(
  filePath: string,
  extraEnv: Record<string, string> = {}
): Promise<{ port: number; proc: ReturnType<typeof Bun.spawn>; stop: () => void }> {
  const { proc, port } = await spawnCLI(filePath, extraEnv);
  await waitForServer(port);
  return { port, proc, stop: () => { try { proc.kill(); } catch {} } };
}

/** POST a comment and return the created comment object. */
export async function postComment(
  port: number,
  selection: { quote: string; context_before?: string; context_after?: string },
  message: string
): Promise<{ id: string; quote: string; thread: any[]; resolved: boolean }> {
  const res = await fetch(`http://localhost:${port}/api/comment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
