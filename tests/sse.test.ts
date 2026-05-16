// SSE broadcast assertions. Each event-producing endpoint has a paired test:
// subscribe to /api/events first, perform the action, then await the event.
// Keeps coverage tight against the broadcast contract that the client UI
// (and the agent process) rely on.

import { test, expect, afterEach } from "bun:test";
import {
  createTestFile,
  startServer,
  postComment,
  waitForEvent,
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

const SAMPLE = "# Doc\n\nFirst paragraph here.\n\nSecond paragraph here.\n";

// ── Comment lifecycle broadcasts ─────────────────────────────────────────

test("POST /api/comment broadcasts comment-added", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const evP = waitForEvent(port, "comment-added");
  await evP.ready;
  const c = await postComment(port, { quote: "First paragraph" }, "msg");
  const ev = await evP;

  expect(ev.data.commentId).toBe(c.id);
  expect(ev.data.round).toBe(1);
}, 15_000);

test("POST /api/comment/:id/resolve broadcasts comment-resolved with allResolved", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const a = await postComment(port, { quote: "First paragraph" }, "first");
  const b = await postComment(port, { quote: "Second paragraph" }, "second");

  // Resolving one of two: allResolved=false
  const ev1P = waitForEvent(port, "comment-resolved", { predicate: (d) => d.commentId === a.id });
  await ev1P.ready;
  await fetch(`http://localhost:${port}/api/comment/${a.id}/resolve`, { method: "POST", headers: CSRF_HEADERS });
  const ev1 = await ev1P;
  expect(ev1.data.allResolved).toBe(false);

  // Resolving the second: allResolved=true
  const ev2P = waitForEvent(port, "comment-resolved", { predicate: (d) => d.commentId === b.id });
  await ev2P.ready;
  await fetch(`http://localhost:${port}/api/comment/${b.id}/resolve`, { method: "POST", headers: CSRF_HEADERS });
  const ev2 = await ev2P;
  expect(ev2.data.allResolved).toBe(true);
}, 15_000);

test("POST /api/comment/:id/reopen broadcasts comment-resolved with recomputed allResolved", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const c = await postComment(port, { quote: "First paragraph" }, "x");
  await fetch(`http://localhost:${port}/api/comment/${c.id}/resolve`, { method: "POST", headers: CSRF_HEADERS });

  // Reopen path uses the same comment-resolved event so existing UI handlers re-render.
  // allResolved must flip back to false because the only comment is no longer resolved.
  const evP = waitForEvent(port, "comment-resolved", { predicate: (d) => d.commentId === c.id });
  await evP.ready;
  await fetch(`http://localhost:${port}/api/comment/${c.id}/reopen`, { method: "POST", headers: CSRF_HEADERS });
  const ev = await evP;
  expect(ev.data.allResolved).toBe(false);
}, 15_000);

test("POST /api/comment/:id/reply broadcasts comment-reply for human replies", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const c = await postComment(port, { quote: "First paragraph" }, "x");

  // Only human replies broadcast (the agent listens for these to know when
  // to respond again). Agent replies skip the broadcast — agent-replied
  // is what clears UI state after the agent finishes.
  const evP = waitForEvent(port, "comment-reply", { predicate: (d) => d.commentId === c.id });
  await evP.ready;
  await fetch(`http://localhost:${port}/api/comment/${c.id}/reply`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({ role: "human", message: "follow up" }),
  });
  const ev = await evP;
  expect(ev.data.round).toBe(1);
}, 15_000);

test("POST /api/comment/:id/reply does NOT broadcast for agent replies", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const c = await postComment(port, { quote: "First paragraph" }, "x");

  // Subscribe to comment-reply with a short timeout — should time out.
  const evP = waitForEvent(port, "comment-reply", {
    predicate: (d) => d.commentId === c.id,
    timeoutMs: 500,
  });
  await evP.ready;
  await fetch(`http://localhost:${port}/api/comment/${c.id}/reply`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({ role: "agent", name: "Claude", message: "ack" }),
  });
  await expect(evP).rejects.toThrow(/Timed out/);
}, 15_000);

test("POST /api/comment/:id/reply broadcasts comment-reply for author replies", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const c = await postComment(port, { quote: "First paragraph" }, "x");

  const evP = waitForEvent(port, "comment-reply", { predicate: (d) => d.commentId === c.id });
  await evP.ready;
  await fetch(`http://localhost:${port}/api/comment/${c.id}/reply`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({ role: "agent", name: "Author", message: "Use sentence case.", author: true }),
  });
  const ev = await evP;
  expect(ev.data.round).toBe(1);
}, 15_000);

test("POST /api/comment/:id/thinking broadcasts comment-thinking", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const c = await postComment(port, { quote: "First paragraph" }, "x");

  const evP = waitForEvent(port, "comment-thinking", { predicate: (d) => d.commentId === c.id });
  await evP.ready;
  await fetch(`http://localhost:${port}/api/comment/${c.id}/thinking`, { method: "POST", headers: CSRF_HEADERS });
  const ev = await evP;
  expect(ev.data.commentId).toBe(c.id);
}, 15_000);

test("POST /api/agent-replied broadcasts agent-replied", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);
  await postComment(port, { quote: "First paragraph" }, "x");

  const evP = waitForEvent(port, "agent-replied");
  await evP.ready;
  await fetch(`http://localhost:${port}/api/agent-replied`, { method: "POST", headers: CSRF_HEADERS });
  const ev = await evP;
  expect(ev.data.round).toBe(1);
}, 15_000);

// ── Revision flow broadcasts ─────────────────────────────────────────────

test("POST /api/accept broadcasts accepted", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);
  await postComment(port, { quote: "First paragraph" }, "x");

  const evP = waitForEvent(port, "accepted");
  await evP.ready;
  await fetch(`http://localhost:${port}/api/accept`, { method: "POST", headers: CSRF_HEADERS });
  const ev = await evP;
  expect(ev.data.round).toBe(1);
}, 15_000);

test("POST /api/reload broadcasts reload (revision-finish trigger)", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const evP = waitForEvent(port, "reload");
  await evP.ready;
  await fetch(`http://localhost:${port}/api/reload`, { method: "POST", headers: CSRF_HEADERS });
  const ev = await evP;
  expect(ev.event).toBe("reload");
}, 15_000);

// ── Revision watchdog ─────────────────────────────────────────────────────

test("watchdog broadcasts revision-stalled and un-resolves the round on timeout", async () => {
  // Run createServer inline (no agent subprocess) so the watchdog isn't
  // pre-empted by the agent posting /api/revision-error in response to its
  // failed resolve() call. We're testing the server's stall-detection path.
  const { createServer } = await import("../src/server");
  const { filePath, dir } = createTestFile(SAMPLE);
  process.env.REDLINE_REVISION_TIMEOUT_MS = "500";
  const app = createServer(filePath, { csrfToken: TEST_CSRF_TOKEN });
  const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 0 });
  delete process.env.REDLINE_REVISION_TIMEOUT_MS;
  stops.push(() => { try { server.stop(true); } catch {} });
  const port = server.port;

  await postComment(port, { quote: "First paragraph" }, "x");

  // Subscribe before triggering — closes the broadcast race.
  const stall = waitForEvent(port, "revision-stalled", { timeoutMs: 4000 });
  await stall.ready;

  // /api/accept marks the round resolved AND starts the watchdog.
  await fetch(`http://localhost:${port}/api/accept`, { method: "POST", headers: CSRF_HEADERS });

  // Watchdog fires after ~500ms with no terminal event arriving.
  const ev = await stall;
  expect(ev.data.message).toContain("did not complete");

  // The server should also have un-resolved the round so Revise is meaningful again.
  const sidecarRaw = await Bun.file(`${dir}/.review/test.md.json`).text();
  const sidecar = JSON.parse(sidecarRaw);
  expect(sidecar.rounds[0].resolved_at).toBeNull();
}, 10_000);

test("watchdog is cleared by /api/reload", async () => {
  const { createServer } = await import("../src/server");
  const { filePath } = createTestFile(SAMPLE);
  process.env.REDLINE_REVISION_TIMEOUT_MS = "500";
  const app = createServer(filePath, { csrfToken: TEST_CSRF_TOKEN });
  const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 0 });
  delete process.env.REDLINE_REVISION_TIMEOUT_MS;
  stops.push(() => { try { server.stop(true); } catch {} });
  const port = server.port;

  await postComment(port, { quote: "First paragraph" }, "x");
  await fetch(`http://localhost:${port}/api/accept`, { method: "POST", headers: CSRF_HEADERS });
  // Successful revision lands.
  await fetch(`http://localhost:${port}/api/reload`, { method: "POST", headers: CSRF_HEADERS });

  // Now wait past the watchdog window. If the timer wasn't cleared, we'd see
  // a (spurious) revision-stalled event.
  const sub = waitForEvent(port, "revision-stalled", { timeoutMs: 1500 });
  await sub.ready;
  await expect(sub).rejects.toThrow(/Timed out/);
}, 10_000);

test("POST /api/agent-unavailable broadcasts agent-unavailable with reason", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const evP = waitForEvent(port, "agent-unavailable");
  await evP.ready;
  await fetch(`http://localhost:${port}/api/agent-unavailable`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({ reason: "Agent crashed 5× in 60s — replies unavailable." }),
  });
  const ev = await evP;
  expect(ev.event).toBe("agent-unavailable");
  expect(ev.data.reason).toContain("Agent crashed");
}, 15_000);

test("POST /api/agent-unavailable falls back to a default reason if body is empty", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const evP = waitForEvent(port, "agent-unavailable");
  await evP.ready;
  await fetch(`http://localhost:${port}/api/agent-unavailable`, {
    method: "POST",
    headers: CSRF_HEADERS,
  });
  const ev = await evP;
  expect(ev.data.reason).toBeTruthy();
  expect(typeof ev.data.reason).toBe("string");
}, 15_000);

test("POST /api/revision-no-changes broadcasts revision-no-changes", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const evP = waitForEvent(port, "revision-no-changes");
  await evP.ready;
  await fetch(`http://localhost:${port}/api/revision-no-changes`, { method: "POST", headers: CSRF_HEADERS });
  const ev = await evP;
  expect(ev.event).toBe("revision-no-changes");
}, 15_000);

test("POST /api/revision-chunk broadcasts revision-chunk with text + kind", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const evP = waitForEvent(port, "revision-chunk");
  await evP.ready;
  await fetch(`http://localhost:${port}/api/revision-chunk`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({ text: "thinking out loud", kind: "thinking" }),
  });
  const ev = await evP;
  expect(ev.data.text).toBe("thinking out loud");
  expect(ev.data.kind).toBe("thinking");
}, 15_000);

test("POST /api/revision-error broadcasts revision-error with message", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const evP = waitForEvent(port, "revision-error");
  await evP.ready;
  await fetch(`http://localhost:${port}/api/revision-error`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({ message: "claude blew up" }),
  });
  const ev = await evP;
  expect(ev.data.message).toBe("claude blew up");
}, 15_000);

// ── Submit (HITL signal — kept around for compat) ────────────────────────

test("POST /api/submit broadcasts submitted with comment count", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);
  await postComment(port, { quote: "First paragraph" }, "1");
  await postComment(port, { quote: "Second paragraph" }, "2");

  const evP = waitForEvent(port, "submitted");
  await evP.ready;
  await fetch(`http://localhost:${port}/api/submit`, { method: "POST", headers: CSRF_HEADERS });
  const ev = await evP;
  expect(ev.data.round).toBe(1);
  expect(ev.data.comments).toBe(2);
}, 15_000);

// ── Disconnect cleanup ───────────────────────────────────────────────────

test("disconnecting an SSE client doesn't break later broadcasts to other clients", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  // Briefly connect and disconnect a first client.
  const earlyP = waitForEvent(port, "comment-added", { client: "early" });
  await earlyP.ready;
  await postComment(port, { quote: "First paragraph" }, "first");
  await earlyP;
  earlyP.stop();
  await Bun.sleep(50); // give server a moment to clean up the controller

  // A second client should still receive future broadcasts.
  const lateP = waitForEvent(port, "comment-added", { client: "late" });
  await lateP.ready;
  const c2 = await postComment(port, { quote: "Second paragraph" }, "second");
  const ev = await lateP;
  expect(ev.data.commentId).toBe(c2.id);
}, 15_000);
