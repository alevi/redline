// End-to-end tests for the agent process and the resolve flow, with a mocked
// `claude` CLI. The agent + revision logic runs as the production CLI does
// (cli.ts spawns agent.ts) — only the model call is mocked.

import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { readFile, readdir } from "fs/promises";
import path from "path";
import os from "os";
import {
  spawnCLI,
  waitForServer,
  postComment,
  waitForEvent,
  installClaudeShim,
  TEST_CSRF_TOKEN,
} from "./helpers";

const CSRF_HEADERS = { "X-Redline-Token": TEST_CSRF_TOKEN };

const procs: ReturnType<typeof Bun.spawn>[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const p of procs.splice(0)) {
    try { p.kill(); } catch { /* already dead */ }
  }
  // Tmp dirs left behind are fine (mkdtemp cleanup is OS-managed)
  dirs.splice(0);
});

function makeTestDir(content: string): { filePath: string; dir: string; shim: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "redline-agent-test-"));
  dirs.push(dir);
  const filePath = path.join(dir, "test.md");
  writeFileSync(filePath, content);
  const shim = installClaudeShim(dir);
  return { filePath, dir, shim };
}

async function startWithShim(filePath: string, shim: string, extraEnv: Record<string, string> = {}) {
  const { proc, port, agentReady } = await spawnCLI(filePath, {
    CLAUDE_CODE_EXECPATH: shim,
    ...extraEnv,
  });
  procs.push(proc);
  await waitForServer(port);
  // Don't return until the agent has subscribed to /api/events. Otherwise
  // the first comment we POST broadcasts before the agent is listening, and
  // the test will hang waiting for thinking/reply events.
  await agentReady;
  return { proc, port };
}

const SAMPLE = "# Doc\n\nFirst paragraph here.\n\nSecond paragraph here.\n";

// ── Agent reply flow ─────────────────────────────────────────────────────

test("agent posts thinking + reply when a comment is added", async () => {
  const { filePath, shim } = makeTestDir(SAMPLE);
  const { port } = await startWithShim(filePath, shim, { REDLINE_SHIM_REPLY: "Acknowledged." });

  // Subscribe to the two events the agent will fire as it processes the comment.
  const thinkingP = waitForEvent(port, "comment-thinking", { timeoutMs: 8000 });
  const repliedP = waitForEvent(port, "agent-replied", { timeoutMs: 8000 });
  await Promise.all([thinkingP.ready, repliedP.ready]);

  await postComment(port, { quote: "First paragraph" }, "what about this?");

  const thinking = await thinkingP;
  expect(thinking.event).toBe("comment-thinking");
  await repliedP;

  // The agent reply should be in the sidecar thread.
  const sidecar = await fetch(`http://localhost:${port}/api/sidecar`).then((r) => r.json());
  const comment = sidecar.rounds[0].comments[0];
  expect(comment.thread).toHaveLength(2);
  expect(comment.thread[1]).toMatchObject({ role: "agent", message: "Acknowledged." });
}, 20_000);

test("agent does not reply twice if comment-added fires multiple times", async () => {
  // The inProgress dedup set in agent.ts is the safety net we're pinning here.
  // Two rapid comment-added events for the same comment should produce one reply.
  const { filePath, shim } = makeTestDir(SAMPLE);
  const { port } = await startWithShim(filePath, shim, { REDLINE_SHIM_REPLY: "ok" });

  const repliedP = waitForEvent(port, "agent-replied", { timeoutMs: 8000 });
  await repliedP.ready;
  await postComment(port, { quote: "First paragraph" }, "test");
  await repliedP;
  await Bun.sleep(200); // guard against any in-flight second reply

  const sidecar = await fetch(`http://localhost:${port}/api/sidecar`).then((r) => r.json());
  const thread = sidecar.rounds[0].comments[0].thread;
  // 1 human + exactly 1 agent reply
  expect(thread).toHaveLength(2);
  expect(thread.filter((e: any) => e.role === "agent")).toHaveLength(1);
}, 20_000);

// ── Envelope parsing end-to-end ──────────────────────────────────────────

test("delimiter envelope: message with unescaped quotes round-trips intact", async () => {
  // Replays the failure that motivated switching from JSON to a delimiter
  // envelope: a model reply whose `message` string contains literal `"..."`
  // would break JSON.parse, the agent would fall back to raw text, and the
  // whole envelope (markers and all) would land in the comment thread.
  //
  // With the delimiter format, no escaping is needed — the message is taken
  // verbatim between ---MESSAGE--- and ---END---, and the verdict is read
  // from REQUIRES_REVISION.
  const messageWithQuotes =
    'It\'s a colloquial shorthand for "hard-won through painful debugging." ' +
    'The CLAUDE.md docs section is literally titled "Frontend gotchas (paid in blood)".';
  const envelope =
    "REQUIRES_REVISION: false\n" +
    "REASON: \n" +
    "---MESSAGE---\n" +
    messageWithQuotes + "\n" +
    "---END---";

  const { filePath, shim } = makeTestDir(SAMPLE);
  const { port } = await startWithShim(filePath, shim, { REDLINE_SHIM_REPLY: envelope });

  const repliedP = waitForEvent(port, "agent-replied", { timeoutMs: 8000 });
  await repliedP.ready;
  await postComment(port, { quote: "First paragraph" }, "elaborate?");
  await repliedP;

  const sidecar = await fetch(`http://localhost:${port}/api/sidecar`).then((r) => r.json());
  const reply = sidecar.rounds[0].comments[0].thread[1];
  expect(reply.role).toBe("agent");
  expect(reply.message).toBe(messageWithQuotes);
  // No envelope leakage into the rendered message
  expect(reply.message).not.toContain("---MESSAGE---");
  expect(reply.message).not.toContain("REQUIRES_REVISION");
  // Verdict honored, not the safe-default fallback to true
  expect(reply.requires_revision).toBe(false);
}, 20_000);

test("delimiter envelope: revise verdict + reason flow through to the sidecar", async () => {
  const envelope =
    "REQUIRES_REVISION: true\n" +
    "REASON: drop the offline-first framing\n" +
    "---MESSAGE---\n" +
    "Got it.\n" +
    "---END---";

  const { filePath, shim } = makeTestDir(SAMPLE);
  const { port } = await startWithShim(filePath, shim, { REDLINE_SHIM_REPLY: envelope });

  const repliedP = waitForEvent(port, "agent-replied", { timeoutMs: 8000 });
  await repliedP.ready;
  await postComment(port, { quote: "First paragraph" }, "rephrase this");
  await repliedP;

  const sidecar = await fetch(`http://localhost:${port}/api/sidecar`).then((r) => r.json());
  const reply = sidecar.rounds[0].comments[0].thread[1];
  expect(reply.message).toBe("Got it.");
  expect(reply.requires_revision).toBe(true);
  expect(reply.revision_reason).toBe("drop the offline-first framing");
}, 20_000);

test("delimiter envelope: ESCALATE flag flows through to the sidecar", async () => {
  const envelope =
    "REQUIRES_REVISION: false\n" +
    "ESCALATE: true\n" +
    "REASON: \n" +
    "---MESSAGE---\n" +
    "I don't have the style guide — routed to the launching agent.\n" +
    "---END---";

  const { filePath, shim } = makeTestDir(SAMPLE);
  const { port } = await startWithShim(filePath, shim, { REDLINE_SHIM_REPLY: envelope });

  const repliedP = waitForEvent(port, "agent-replied", { timeoutMs: 8000 });
  await repliedP.ready;
  await postComment(port, { quote: "First paragraph" }, "run the house style guide");
  await repliedP;

  const sidecar = await fetch(`http://localhost:${port}/api/sidecar`).then((r) => r.json());
  const reply = sidecar.rounds[0].comments[0].thread[1];
  expect(reply.role).toBe("agent");
  expect(reply.escalate).toBe(true);
  expect(reply.requires_revision).toBe(false);
}, 20_000);

test("delimiter envelope: no ESCALATE line leaves escalate unset", async () => {
  const envelope =
    "REQUIRES_REVISION: false\n" +
    "REASON: \n" +
    "---MESSAGE---\n" +
    "Looks fine to me.\n" +
    "---END---";

  const { filePath, shim } = makeTestDir(SAMPLE);
  const { port } = await startWithShim(filePath, shim, { REDLINE_SHIM_REPLY: envelope });

  const repliedP = waitForEvent(port, "agent-replied", { timeoutMs: 8000 });
  await repliedP.ready;
  await postComment(port, { quote: "First paragraph" }, "all good?");
  await repliedP;

  const sidecar = await fetch(`http://localhost:${port}/api/sidecar`).then((r) => r.json());
  const reply = sidecar.rounds[0].comments[0].thread[1];
  expect(reply.escalate).toBeUndefined();
}, 20_000);

// ── Resolve / revision flow ──────────────────────────────────────────────

test("accept triggers revision; revised file is written and round 2 opens", async () => {
  const { filePath, shim } = makeTestDir(SAMPLE);
  const { port } = await startWithShim(filePath, shim, {
    REDLINE_SHIM_REPLY: "ok",
    REDLINE_SHIM_REVISION: "modify",
  });

  // Add a comment, wait for agent to reply, then resolve it (so it counts as
  // settled when the revision runs), then accept.
  const repliedP = waitForEvent(port, "agent-replied", { timeoutMs: 8000 });
  await repliedP.ready;
  const c = await postComment(port, { quote: "First paragraph" }, "fix this");
  await repliedP;
  await fetch(`http://localhost:${port}/api/comment/${c.id}/resolve`, { method: "POST", headers: CSRF_HEADERS });

  // Accept fires "accepted" → agent runs the resolve flow → reload broadcasts
  // when the revised file is written. Subscribe to reload before triggering.
  const reloadP = waitForEvent(port, "reload", { timeoutMs: 15000 });
  await reloadP.ready;
  await fetch(`http://localhost:${port}/api/accept`, { method: "POST", headers: CSRF_HEADERS });
  await reloadP;

  // The shim appends a "Revised by shim" section. Verify the file changed.
  const revised = await readFile(filePath, "utf-8");
  expect(revised).toContain("## Revised by shim");
  expect(revised).toContain("First paragraph here."); // original preserved

  // Sidecar should have two rounds now: round 1 resolved, round 2 open and empty.
  const sidecar = await fetch(`http://localhost:${port}/api/sidecar`).then((r) => r.json());
  expect(sidecar.rounds).toHaveLength(2);
  expect(sidecar.rounds[0].resolved_at).not.toBeNull();
  expect(sidecar.rounds[1].resolved_at).toBeNull();
  expect(sidecar.rounds[1].comments).toHaveLength(0);

  // Snapshot of pre-revision file should exist in .review/history/
  const histDir = path.join(path.dirname(filePath), ".review", "history");
  const snapshots = await readdir(histDir);
  expect(snapshots.length).toBeGreaterThanOrEqual(1);
  expect(snapshots[0]).toMatch(/^test\.md\..*\.md$/);
}, 25_000);

test("revision producing no changes broadcasts revision-no-changes (not reload)", async () => {
  const { filePath, shim } = makeTestDir(SAMPLE);
  const { port } = await startWithShim(filePath, shim, {
    REDLINE_SHIM_REPLY: "ok",
    REDLINE_SHIM_REVISION: "no-changes",
  });

  const repliedP = waitForEvent(port, "agent-replied", { timeoutMs: 8000 });
  await repliedP.ready;
  const c = await postComment(port, { quote: "First paragraph" }, "...");
  await repliedP;
  await fetch(`http://localhost:${port}/api/comment/${c.id}/resolve`, { method: "POST", headers: CSRF_HEADERS });

  const noChangeP = waitForEvent(port, "revision-no-changes", { timeoutMs: 15000 });
  await noChangeP.ready;
  await fetch(`http://localhost:${port}/api/accept`, { method: "POST", headers: CSRF_HEADERS });
  await noChangeP;

  // The file should be untouched.
  const after = await readFile(filePath, "utf-8");
  expect(after).toBe(SAMPLE);
}, 25_000);

test("revision failure broadcasts revision-error and writes errors.log", async () => {
  const { filePath, dir, shim } = makeTestDir(SAMPLE);
  const { port } = await startWithShim(filePath, shim, {
    REDLINE_SHIM_REPLY: "ok",
    REDLINE_SHIM_REVISION: "fail",
  });

  const repliedP = waitForEvent(port, "agent-replied", { timeoutMs: 8000 });
  await repliedP.ready;
  const c = await postComment(port, { quote: "First paragraph" }, "...");
  await repliedP;
  await fetch(`http://localhost:${port}/api/comment/${c.id}/resolve`, { method: "POST", headers: CSRF_HEADERS });

  const errP = waitForEvent(port, "revision-error", { timeoutMs: 15000 });
  await errP.ready;
  await fetch(`http://localhost:${port}/api/accept`, { method: "POST", headers: CSRF_HEADERS });
  const ev = await errP;
  expect(ev.data.message).toMatch(/exited with code 1/);

  // Errors log should exist with a reason recorded
  const logPath = path.join(dir, ".review", "errors.log");
  const log = await readFile(logPath, "utf-8");
  expect(log).toContain("reason:");
  expect(log).toContain("exitCode:     1");
}, 25_000);

test("revision retries once on mangled output and succeeds on the retry", async () => {
  const { filePath, dir, shim } = makeTestDir(SAMPLE);
  const counter = path.join(dir, "shim-count");
  const { port } = await startWithShim(filePath, shim, {
    REDLINE_SHIM_REPLY: "ok",
    REDLINE_SHIM_REVISION: "mangle-once",
    REDLINE_SHIM_COUNTER: counter,
  });

  const repliedP = waitForEvent(port, "agent-replied", { timeoutMs: 8000 });
  await repliedP.ready;
  const c = await postComment(port, { quote: "First paragraph" }, "fix this");
  await repliedP;
  await fetch(`http://localhost:${port}/api/comment/${c.id}/resolve`, { method: "POST", headers: CSRF_HEADERS });

  // First attempt drops the heading (rejected); the retry returns a clean
  // revision, so `reload` still fires.
  const reloadP = waitForEvent(port, "reload", { timeoutMs: 15000 });
  await reloadP.ready;
  await fetch(`http://localhost:${port}/api/accept`, { method: "POST", headers: CSRF_HEADERS });
  await reloadP;

  const revised = await readFile(filePath, "utf-8");
  expect(revised).toContain("## Revised by shim");
  // Two shim invocations: a mangled first attempt + a clean retry.
  expect((await readFile(counter, "utf-8")).trim()).toBe("2");
}, 25_000);

test("revision that stays mangled fails after the retry, not on the first attempt", async () => {
  const { filePath, dir, shim } = makeTestDir(SAMPLE);
  const counter = path.join(dir, "shim-count");
  const { port } = await startWithShim(filePath, shim, {
    REDLINE_SHIM_REPLY: "ok",
    REDLINE_SHIM_REVISION: "mangle",
    REDLINE_SHIM_COUNTER: counter,
  });

  const repliedP = waitForEvent(port, "agent-replied", { timeoutMs: 8000 });
  await repliedP.ready;
  const c = await postComment(port, { quote: "First paragraph" }, "fix this");
  await repliedP;
  await fetch(`http://localhost:${port}/api/comment/${c.id}/resolve`, { method: "POST", headers: CSRF_HEADERS });

  const errP = waitForEvent(port, "revision-error", { timeoutMs: 15000 });
  await errP.ready;
  await fetch(`http://localhost:${port}/api/accept`, { method: "POST", headers: CSRF_HEADERS });
  await errP;

  // Both attempts ran before giving up.
  expect((await readFile(counter, "utf-8")).trim()).toBe("2");
  // The logged reason is the accurate validator message, not the old
  // misleading "no Markdown heading" wording.
  const log = await readFile(path.join(dir, ".review", "errors.log"), "utf-8");
  expect(log).toContain("no Markdown headings");
}, 25_000);
