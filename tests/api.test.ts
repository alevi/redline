// HTTP API integration tests. Spins up a real server per test, hits endpoints
// over fetch, asserts response shape and (where relevant) sidecar persistence.

import { test, expect, afterEach } from "bun:test";
import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import {
  createTestFile,
  startServer,
  postComment,
} from "./helpers";

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

async function start(filePath: string) {
  const s = await startServer(filePath);
  stops.push(s.stop);
  return s;
}

const SAMPLE = "# Doc\n\nThis is the first paragraph with selectable text.\n\nA second paragraph here.\n";

// ── /api/comment (POST) ───────────────────────────────────────────────────

test("POST /api/comment creates a comment and persists to sidecar", async () => {
  const { filePath, dir } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const c = await postComment(port, { quote: "first paragraph" }, "fix this");
  expect(c.id).toMatch(/^c\d+$/);
  expect(c.quote).toBe("first paragraph");
  expect(c.resolved).toBe(false);
  expect(c.thread).toHaveLength(1);
  expect(c.thread[0]).toMatchObject({ role: "human", message: "fix this" });

  // Sidecar on disk should have the same comment
  const sidecarRaw = await readFile(path.join(dir, ".review", "test.md.json"), "utf-8");
  const sidecar = JSON.parse(sidecarRaw);
  expect(sidecar.rounds).toHaveLength(1);
  expect(sidecar.rounds[0].comments).toHaveLength(1);
  expect(sidecar.rounds[0].comments[0].id).toBe(c.id);
}, 15_000);

test("POST /api/comment generates unique ids even under same-ms collisions", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  // Fire 3 sequentially-awaited POSTs. They land within a millisecond on a
  // local server, which is exactly the case where Date.now()-only IDs collide.
  // Higher concurrency exposes a separate sidecar read-modify-write race —
  // logged as a followup, not in scope for the ID-uniqueness regression check.
  const a = await postComment(port, { quote: "first paragraph", context_after: "a" }, "1");
  const b = await postComment(port, { quote: "first paragraph", context_after: "b" }, "2");
  const c = await postComment(port, { quote: "first paragraph", context_after: "c" }, "3");
  const ids = new Set([a.id, b.id, c.id]);
  expect(ids.size).toBe(3);
}, 15_000);

// ── /api/comments (GET) ───────────────────────────────────────────────────

test("GET /api/comments returns comments, roundResolved, and totalRounds", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  await postComment(port, { quote: "first paragraph" }, "msg");
  const res = await fetch(`http://localhost:${port}/api/comments`);
  const data = await res.json();

  expect(Array.isArray(data.comments)).toBe(true);
  expect(data.comments).toHaveLength(1);
  expect(data.roundResolved).toBe(false);
  // totalRounds is what the SSE reconnect path keys off of — must be present.
  expect(data.totalRounds).toBe(1);
}, 15_000);

// ── /api/comment/:id/resolve and /reopen ──────────────────────────────────

test("POST /api/comment/:id/resolve marks resolved and reports allResolved", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const a = await postComment(port, { quote: "first paragraph" }, "first");
  const b = await postComment(port, { quote: "second paragraph" }, "second");

  // Resolving only one → allResolved should be false
  const r1 = await fetch(`http://localhost:${port}/api/comment/${a.id}/resolve`, { method: "POST" });
  const d1 = await r1.json();
  expect(d1.ok).toBe(true);
  expect(d1.allResolved).toBe(false);

  // Resolving the second → allResolved flips true
  const r2 = await fetch(`http://localhost:${port}/api/comment/${b.id}/resolve`, { method: "POST" });
  const d2 = await r2.json();
  expect(d2.allResolved).toBe(true);
}, 15_000);

test("POST /api/comment/:id/reopen flips resolved back to false", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const c = await postComment(port, { quote: "first paragraph" }, "x");
  await fetch(`http://localhost:${port}/api/comment/${c.id}/resolve`, { method: "POST" });

  const reopened = await fetch(`http://localhost:${port}/api/comment/${c.id}/reopen`, { method: "POST" });
  const data = await reopened.json();
  expect(data.ok).toBe(true);
  expect(data.comment.resolved).toBe(false);
}, 15_000);

test("POST /api/comment/:id/resolve returns 404 for unknown comment", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);
  // No comment exists yet → no round either, server returns 400 "No active round"
  await postComment(port, { quote: "first paragraph" }, "x"); // ensure round exists
  const res = await fetch(`http://localhost:${port}/api/comment/c999999/resolve`, { method: "POST" });
  expect(res.status).toBe(404);
}, 15_000);

// ── /api/comment/:id/reply and /thinking ──────────────────────────────────

test("POST /api/comment/:id/reply appends to the thread", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const c = await postComment(port, { quote: "first paragraph" }, "initial");

  const replyRes = await fetch(`http://localhost:${port}/api/comment/${c.id}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "agent", name: "Claude", message: "ack" }),
  });
  expect(replyRes.status).toBe(200);

  const sidecar = await fetch(`http://localhost:${port}/api/sidecar`).then((r) => r.json());
  const updated = sidecar.rounds[0].comments[0];
  expect(updated.thread).toHaveLength(2);
  expect(updated.thread[1]).toMatchObject({ role: "agent", name: "Claude", message: "ack" });
}, 15_000);

test("POST /api/comment/:id/thinking succeeds (broadcast hook)", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);
  const c = await postComment(port, { quote: "first paragraph" }, "x");
  const res = await fetch(`http://localhost:${port}/api/comment/${c.id}/thinking`, { method: "POST" });
  expect(res.status).toBe(200);
}, 15_000);

test("POST /api/agent-replied succeeds (broadcast hook)", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);
  await postComment(port, { quote: "first paragraph" }, "x");
  const res = await fetch(`http://localhost:${port}/api/agent-replied`, { method: "POST" });
  expect(res.status).toBe(200);
}, 15_000);

// ── /api/sidecar ──────────────────────────────────────────────────────────

test("GET /api/sidecar returns full sidecar state", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);
  await postComment(port, { quote: "first paragraph" }, "msg");
  const res = await fetch(`http://localhost:${port}/api/sidecar`);
  const sidecar = await res.json();
  expect(sidecar.file).toBe("test.md");
  expect(sidecar.rounds).toHaveLength(1);
  expect(sidecar.rounds[0].comments).toHaveLength(1);
}, 15_000);

// ── Asset serving (catch-all GET) ─────────────────────────────────────────

test("GET serves a sibling asset from the markdown's directory", async () => {
  const { filePath, dir } = createTestFile(SAMPLE);
  await writeFile(path.join(dir, "diagram.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const { port } = await start(filePath);

  const res = await fetch(`http://localhost:${port}/diagram.png`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
}, 15_000);

test("GET blocks path traversal outside the doc directory", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);
  // Request something well outside the worktree
  const res = await fetch(`http://localhost:${port}/../../../../etc/hosts`);
  expect(res.status).toBe(404);
}, 15_000);

test("GET blocks reads inside .review/ (sidecar must not leak)", async () => {
  const { filePath, dir } = createTestFile(SAMPLE);
  const { port } = await start(filePath);
  await postComment(port, { quote: "first paragraph" }, "secret");

  // Sidecar exists on disk now
  const sidecarPath = path.join(dir, ".review", "test.md.json");
  expect(await Bun.file(sidecarPath).exists()).toBe(true);

  const res = await fetch(`http://localhost:${port}/.review/test.md.json`);
  expect(res.status).toBe(404);
}, 15_000);

test("GET / does not double-serve the markdown via the asset route", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);
  // The markdown itself is rendered at /, not served raw via the catch-all.
  const res = await fetch(`http://localhost:${port}/test.md`);
  expect(res.status).toBe(404);
}, 15_000);
