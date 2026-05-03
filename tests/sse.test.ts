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

const SAMPLE = "# Doc\n\nFirst paragraph here.\n\nSecond paragraph here.\n";

// ── Comment lifecycle broadcasts ─────────────────────────────────────────

test("POST /api/comment broadcasts comment-added", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const evP = waitForEvent(port, "comment-added");
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
  await fetch(`http://localhost:${port}/api/comment/${a.id}/resolve`, { method: "POST" });
  const ev1 = await ev1P;
  expect(ev1.data.allResolved).toBe(false);

  // Resolving the second: allResolved=true
  const ev2P = waitForEvent(port, "comment-resolved", { predicate: (d) => d.commentId === b.id });
  await fetch(`http://localhost:${port}/api/comment/${b.id}/resolve`, { method: "POST" });
  const ev2 = await ev2P;
  expect(ev2.data.allResolved).toBe(true);
}, 15_000);

test("POST /api/comment/:id/reopen broadcasts comment-resolved with recomputed allResolved", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const c = await postComment(port, { quote: "First paragraph" }, "x");
  await fetch(`http://localhost:${port}/api/comment/${c.id}/resolve`, { method: "POST" });

  // Reopen path uses the same comment-resolved event so existing UI handlers re-render.
  // allResolved must flip back to false because the only comment is no longer resolved.
  const evP = waitForEvent(port, "comment-resolved", { predicate: (d) => d.commentId === c.id });
  await fetch(`http://localhost:${port}/api/comment/${c.id}/reopen`, { method: "POST" });
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
  await fetch(`http://localhost:${port}/api/comment/${c.id}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  await fetch(`http://localhost:${port}/api/comment/${c.id}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "agent", name: "Claude", message: "ack" }),
  });
  await expect(evP).rejects.toThrow(/Timed out/);
}, 15_000);

test("POST /api/comment/:id/thinking broadcasts comment-thinking", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const c = await postComment(port, { quote: "First paragraph" }, "x");

  const evP = waitForEvent(port, "comment-thinking", { predicate: (d) => d.commentId === c.id });
  await fetch(`http://localhost:${port}/api/comment/${c.id}/thinking`, { method: "POST" });
  const ev = await evP;
  expect(ev.data.commentId).toBe(c.id);
}, 15_000);

test("POST /api/agent-replied broadcasts agent-replied", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);
  await postComment(port, { quote: "First paragraph" }, "x");

  const evP = waitForEvent(port, "agent-replied");
  await fetch(`http://localhost:${port}/api/agent-replied`, { method: "POST" });
  const ev = await evP;
  expect(ev.data.round).toBe(1);
}, 15_000);

// ── Revision flow broadcasts ─────────────────────────────────────────────

test("POST /api/accept broadcasts accepted", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);
  await postComment(port, { quote: "First paragraph" }, "x");

  const evP = waitForEvent(port, "accepted");
  await fetch(`http://localhost:${port}/api/accept`, { method: "POST" });
  const ev = await evP;
  expect(ev.data.round).toBe(1);
}, 15_000);

test("POST /api/reload broadcasts reload (revision-finish trigger)", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const evP = waitForEvent(port, "reload");
  await fetch(`http://localhost:${port}/api/reload`, { method: "POST" });
  const ev = await evP;
  expect(ev.event).toBe("reload");
}, 15_000);

test("POST /api/revision-no-changes broadcasts revision-no-changes", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const evP = waitForEvent(port, "revision-no-changes");
  await fetch(`http://localhost:${port}/api/revision-no-changes`, { method: "POST" });
  const ev = await evP;
  expect(ev.event).toBe("revision-no-changes");
}, 15_000);

test("POST /api/revision-chunk broadcasts revision-chunk with text + kind", async () => {
  const { filePath } = createTestFile(SAMPLE);
  const { port } = await start(filePath);

  const evP = waitForEvent(port, "revision-chunk");
  await fetch(`http://localhost:${port}/api/revision-chunk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  await fetch(`http://localhost:${port}/api/revision-error`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  await fetch(`http://localhost:${port}/api/submit`, { method: "POST" });
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
  await postComment(port, { quote: "First paragraph" }, "first");
  await earlyP;
  earlyP.stop();
  await Bun.sleep(50); // give server a moment to clean up the controller

  // A second client should still receive future broadcasts.
  const lateP = waitForEvent(port, "comment-added", { client: "late" });
  const c2 = await postComment(port, { quote: "Second paragraph" }, "second");
  const ev = await lateP;
  expect(ev.data.commentId).toBe(c2.id);
}, 15_000);
