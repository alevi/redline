// HTTP API integration tests. Spins up a real server per test, hits endpoints
// over fetch, asserts response shape and (where relevant) sidecar persistence.

import { test, expect, afterEach } from "bun:test";
import { readFile, writeFile, mkdir, symlink } from "fs/promises";
import { writeFileSync } from "fs";
import os from "os";
import path from "path";
import {
  createTestFile,
  startServer,
  postComment,
  TEST_CSRF_TOKEN,
} from "./helpers";

const CSRF_HEADERS = { "X-Redline-Token": TEST_CSRF_TOKEN };
const CSRF_JSON_HEADERS = { "Content-Type": "application/json", "X-Redline-Token": TEST_CSRF_TOKEN };

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
  expect(c.id).toMatch(/^c[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
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

test("POST /api/comment serializes 20 concurrent writes with no losses", async () => {
  const { filePath, dir } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  // Fire 20 POSTs simultaneously. Without the per-file mutex these
  // load → mutate → save cycles interleave: writers read the same starting
  // sidecar, push into stale arrays, and the last save wins — silently
  // dropping the others. >5 parallel POSTs reliably 500'd before the fix.
  const N = 20;
  const responses = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      fetch(`http://localhost:${port}/api/comment`, {
        method: "POST",
        headers: CSRF_JSON_HEADERS,
        body: JSON.stringify({
          quote: "first paragraph",
          context_before: "",
          context_after: `#${i}`,
          message: `parallel ${i}`,
        }),
      }),
    ),
  );
  for (const r of responses) expect(r.ok).toBe(true);

  const raw = await readFile(path.join(dir, ".review", "test.md.json"), "utf-8");
  const sidecar = JSON.parse(raw);
  expect(sidecar.rounds).toHaveLength(1);
  expect(sidecar.rounds[0].comments).toHaveLength(N);

  // All ids unique
  const ids = new Set(sidecar.rounds[0].comments.map((c: any) => c.id));
  expect(ids.size).toBe(N);
}, 15_000);

test("POST /api/comment generates unique ids even under same-ms collisions", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  // Fire 3 sequentially-awaited POSTs. They land within a millisecond on a
  // local server, which is exactly the case where Date.now()-only IDs collide.
  // (The higher-concurrency sidecar race is now covered by the test above.)
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

test("GET /api/comments renders thread messageHtml from markdown", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  await postComment(port, { quote: "first paragraph" }, "make it **bold** and a `code` thing");
  const res = await fetch(`http://localhost:${port}/api/comments`);
  const data = await res.json();

  expect(data.comments[0].thread[0].message).toContain("**bold**");
  expect(data.comments[0].thread[0].messageHtml).toContain("<strong>bold</strong>");
  expect(data.comments[0].thread[0].messageHtml).toContain("<code>code</code>");
}, 15_000);

test("GET /api/comments sanitizes dangerous html in thread messages", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  await postComment(port, { quote: "first paragraph" }, "<script>alert(1)</script>ok");
  const res = await fetch(`http://localhost:${port}/api/comments`);
  const data = await res.json();

  expect(data.comments[0].thread[0].messageHtml).not.toContain("<script>");
  expect(data.comments[0].thread[0].messageHtml).toContain("ok");
}, 15_000);

test("GET /api/comments renders agent replies posted through /reply", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const c = await postComment(port, { quote: "first paragraph" }, "what about this?");
  const reply = await fetch(`http://localhost:${port}/api/comment/${c.id}/reply`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({
      role: "agent",
      name: "Claude",
      message: "Here are options:\n\n1. **First** option\n2. **Second** option",
      requires_revision: false,
    }),
  });
  expect(reply.ok).toBe(true);

  const data = await (await fetch(`http://localhost:${port}/api/comments`)).json();
  const agentEntry = data.comments[0].thread[1];
  expect(agentEntry.role).toBe("agent");
  expect(agentEntry.messageHtml).toContain("<ol>");
  expect(agentEntry.messageHtml).toContain("<strong>First</strong>");
  expect(agentEntry.messageHtml).toContain("<strong>Second</strong>");
}, 15_000);

test("GET / bootstraps __REDLINE__.comments with messageHtml per thread entry", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  await postComment(port, { quote: "first paragraph" }, "make it **stronger**");

  const html = await (await fetch(`http://localhost:${port}/`)).text();
  const m = html.match(/window\.__REDLINE__\s*=\s*\{[^]*?comments:\s*(\[[^]*?\])\s*,\s*roundResolved:/);
  expect(m).not.toBeNull();
  const comments = JSON.parse(m![1]);
  expect(comments).toHaveLength(1);
  expect(comments[0].thread[0].messageHtml).toContain("<strong>stronger</strong>");
}, 15_000);

test("GET /round/:n bootstraps messageHtml for the rendered round", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const c = await postComment(port, { quote: "first paragraph" }, "tighten this");
  await fetch(`http://localhost:${port}/api/comment/${c.id}/reply`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({
      role: "agent",
      name: "Claude",
      message: "Two options: `a` and **b**.",
      requires_revision: true,
    }),
  });

  const html = await (await fetch(`http://localhost:${port}/round/1`)).text();
  expect(html).toContain("<code>a</code>");
  expect(html).toContain("<strong>b</strong>");
}, 15_000);

// ── /api/comment/:id/resolve and /reopen ──────────────────────────────────

test("POST /api/comment/:id/resolve marks resolved and reports allResolved", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const a = await postComment(port, { quote: "first paragraph" }, "first");
  const b = await postComment(port, { quote: "second paragraph" }, "second");

  // Resolving only one → allResolved should be false
  const r1 = await fetch(`http://localhost:${port}/api/comment/${a.id}/resolve`, { method: "POST", headers: CSRF_HEADERS });
  const d1 = await r1.json();
  expect(d1.ok).toBe(true);
  expect(d1.allResolved).toBe(false);

  // Resolving the second → allResolved flips true
  const r2 = await fetch(`http://localhost:${port}/api/comment/${b.id}/resolve`, { method: "POST", headers: CSRF_HEADERS });
  const d2 = await r2.json();
  expect(d2.allResolved).toBe(true);
}, 15_000);

test("POST /api/comment/:id/reopen flips resolved back to false", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const c = await postComment(port, { quote: "first paragraph" }, "x");
  await fetch(`http://localhost:${port}/api/comment/${c.id}/resolve`, { method: "POST", headers: CSRF_HEADERS });

  const reopened = await fetch(`http://localhost:${port}/api/comment/${c.id}/reopen`, { method: "POST", headers: CSRF_HEADERS });
  const data = await reopened.json();
  expect(data.ok).toBe(true);
  expect(data.comment.resolved).toBe(false);
}, 15_000);

test("POST /api/comment/:id/resolve returns 404 for unknown comment", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);
  // No comment exists yet → no round either, server returns 400 "No active round"
  await postComment(port, { quote: "first paragraph" }, "x"); // ensure round exists
  const res = await fetch(`http://localhost:${port}/api/comment/c999999/resolve`, { method: "POST", headers: CSRF_HEADERS });
  expect(res.status).toBe(404);
}, 15_000);

// ── /api/comment/:id/reply and /thinking ──────────────────────────────────

test("POST /api/comment/:id/reply appends to the thread", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const c = await postComment(port, { quote: "first paragraph" }, "initial");

  const replyRes = await fetch(`http://localhost:${port}/api/comment/${c.id}/reply`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({ role: "agent", name: "Claude", message: "ack" }),
  });
  expect(replyRes.status).toBe(200);

  const sidecar = await fetch(`http://localhost:${port}/api/sidecar`).then((r) => r.json());
  const updated = sidecar.rounds[0].comments[0];
  expect(updated.thread).toHaveLength(2);
  expect(updated.thread[1]).toMatchObject({ role: "agent", name: "Claude", message: "ack" });
}, 15_000);

test("POST /api/comment/:id/reply persists agent verdict (requires_revision + reason)", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const c = await postComment(port, { quote: "first paragraph" }, "fix typo");

  const replyRes = await fetch(`http://localhost:${port}/api/comment/${c.id}/reply`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({
      role: "agent",
      name: "Claude",
      message: "Will fix.",
      requires_revision: true,
      revision_reason: "fix the misspelled word",
    }),
  });
  expect(replyRes.status).toBe(200);

  const sidecar = await fetch(`http://localhost:${port}/api/sidecar`).then((r) => r.json());
  const entry = sidecar.rounds[0].comments[0].thread[1];
  expect(entry.requires_revision).toBe(true);
  expect(entry.revision_reason).toBe("fix the misspelled word");
}, 15_000);

test("POST /api/comment/:id/reply persists agent escalate flag", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const c = await postComment(port, { quote: "first paragraph" }, "run the style guide");

  await fetch(`http://localhost:${port}/api/comment/${c.id}/reply`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({
      role: "agent",
      name: "Claude",
      message: "Author reply needed.",
      requires_revision: false,
      escalate: true,
    }),
  });

  const sidecar = await fetch(`http://localhost:${port}/api/sidecar`).then((r) => r.json());
  const entry = sidecar.rounds[0].comments[0].thread[1];
  expect(entry.escalate).toBe(true);
}, 15_000);

test("POST /api/comment/:id/reply persists author flag on agent entries", async () => {
  const { filePath, dir } = createTestFile(SAMPLE);
  const { port } = await start(filePath);
  const c = await postComment(port, { quote: "first paragraph" }, "msg");

  await fetch(`http://localhost:${port}/api/comment/${c.id}/reply`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({
      role: "agent",
      name: "Author",
      message: "Use sentence case.",
      author: true,
    }),
  });

  const raw = await readFile(path.join(dir, ".review", "test.md.json"), "utf-8");
  const sidecar = JSON.parse(raw);
  const entry = sidecar.rounds[0].comments[0].thread.at(-1);
  expect(entry.author).toBe(true);
  expect(entry.requires_revision).toBeUndefined();
}, 15_000);

test("POST /api/comment/:id/reply ignores escalate on human entries", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const c = await postComment(port, { quote: "first paragraph" }, "q");

  await fetch(`http://localhost:${port}/api/comment/${c.id}/reply`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({ role: "human", message: "follow-up", escalate: true }),
  });

  const sidecar = await fetch(`http://localhost:${port}/api/sidecar`).then((r) => r.json());
  const entry = sidecar.rounds[0].comments[0].thread[1];
  expect(entry.escalate).toBeUndefined();
}, 15_000);

test("POST /api/comment/:id/reply ignores verdict on human entries", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const c = await postComment(port, { quote: "first paragraph" }, "q");

  // Human entries shouldn't carry a verdict even if one is sent.
  await fetch(`http://localhost:${port}/api/comment/${c.id}/reply`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({ role: "human", message: "follow-up", requires_revision: true }),
  });

  const sidecar = await fetch(`http://localhost:${port}/api/sidecar`).then((r) => r.json());
  const entry = sidecar.rounds[0].comments[0].thread[1];
  expect(entry.role).toBe("human");
  expect(entry.requires_revision).toBeUndefined();
}, 15_000);

test("POST /api/comment/:id/thinking succeeds (broadcast hook)", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);
  const c = await postComment(port, { quote: "first paragraph" }, "x");
  const res = await fetch(`http://localhost:${port}/api/comment/${c.id}/thinking`, { method: "POST", headers: CSRF_HEADERS });
  expect(res.status).toBe(200);
}, 15_000);

test("POST /api/agent-replied succeeds (broadcast hook)", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);
  await postComment(port, { quote: "first paragraph" }, "x");
  const res = await fetch(`http://localhost:${port}/api/agent-replied`, { method: "POST", headers: CSRF_HEADERS });
  expect(res.status).toBe(200);
}, 15_000);

// ── Static asset path traversal & symlink safety ────────────────────────

test("GET /<traversal> with .. is rejected", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);
  // The server's path-resolve check should normalize this back inside docDir
  // and fall through to a missing-file 404 — but it must NOT serve /etc/passwd.
  const res = await fetch(`http://localhost:${port}/../../../../etc/passwd`);
  expect(res.status).toBe(404);
}, 15_000);

test("GET /<symlink> pointing outside docDir is rejected (realpath check)", async () => {
  const { filePath, dir } = createTestFile(SAMPLE);

  // Create a "secret" file outside the doc directory, then a symlink inside
  // the doc directory pointing to it. A naive prefix check on the resolved
  // path before symlink resolution would say "yep, inside docDir" and serve
  // the secret. realpath catches it.
  const secretDir = path.join(os.tmpdir(), `redline-secret-${Date.now()}`);
  await mkdir(secretDir, { recursive: true });
  const secretFile = path.join(secretDir, "secret.png");
  writeFileSync(secretFile, "this should never be served");

  const linkPath = path.join(dir, "leak.png");
  await symlink(secretFile, linkPath);

  const { port } = await start(filePath);
  const res = await fetch(`http://localhost:${port}/leak.png`);
  expect(res.status).toBe(404);
}, 15_000);

test("GET /<legit-image> in docDir is still served (no false positive on realpath)", async () => {
  const { filePath, dir } = createTestFile(SAMPLE);
  const imgPath = path.join(dir, "ok.png");
  writeFileSync(imgPath, "fake-png-bytes");

  const { port } = await start(filePath);
  const res = await fetch(`http://localhost:${port}/ok.png`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
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
