import { test, expect, afterEach } from "bun:test";
import {
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
} from "fs";
import path from "path";
import os from "os";
import {
  createTestFile,
  spawnCLI,
  type SpawnedCLI,
  waitForServer,
  readResult,
  waitForExit,
  waitForEvent,
  postComment,
  TEST_CSRF_TOKEN,
  TEST_ENV,
  BUN,
  CLI,
  installClaudeShim,
} from "./helpers";
import {
  completeCallerRevision,
  postAuthorReply,
  waitForAuthorEvent,
} from "../src/authorHandoff";

const CSRF_HEADERS = { "X-Redline-Token": TEST_CSRF_TOKEN };
const CSRF_JSON_HEADERS = {
  "Content-Type": "application/json",
  "X-Redline-Token": TEST_CSRF_TOKEN,
};

const procs: ReturnType<typeof Bun.spawn>[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) {
    try {
      p.kill();
    } catch {
      /* already dead */
    }
  }
});

async function spawnTracked(
  filePath: string,
  extraEnv: Record<string, string> = {},
  extraArgs: string[] = [],
): Promise<SpawnedCLI> {
  const result = await spawnCLI(filePath, extraEnv, extraArgs);
  procs.push(result.proc);
  return result;
}

async function openBrowserEvents(port: number): Promise<() => Promise<void>> {
  const ac = new AbortController();
  const response = await fetch(
    `http://localhost:${port}/api/events?client=browser`,
    { signal: ac.signal },
  );
  expect(response.ok).toBe(true);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response has no body");

  // Consume the server's initial `: connected` frame. This proves the stream
  // was registered before a test disconnects it or starts a grace-period clock.
  await reader.read();

  return async () => {
    ac.abort();
    try {
      await reader.cancel();
    } catch {
      // Aborting the request may close the reader before cancel() observes it.
    }
  };
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
    body: JSON.stringify({
      quote: "test",
      context_before: "",
      context_after: "",
      message: "x",
    }),
  });
  expect(noHeader.status).toBe(403);

  // Wrong header value: also 403.
  const wrongHeader = await fetch(`http://localhost:${port}/api/comment`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Redline-Token": "not-the-real-one",
    },
    body: JSON.stringify({
      quote: "test",
      context_before: "",
      context_after: "",
      message: "x",
    }),
  });
  expect(wrongHeader.status).toBe(403);

  // Correct header: 200. Confirms the test fixture token is valid end-to-end.
  const ok = await fetch(`http://localhost:${port}/api/comment`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({
      quote: "test",
      context_before: "",
      context_after: "",
      message: "x",
    }),
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

  const startupPath = path.join(
    dir,
    ".review",
    path.basename(filePath) + ".startup.json",
  );

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
  expect(data.result_file).toBe(
    path.join(dir, ".review", path.basename(filePath) + ".result"),
  );
}, 15_000);

test("startup file is removed on abandon so a stale one can't fool the next run", async () => {
  const { filePath, dir } = createTestFile();
  const { proc, port } = await spawnTracked(filePath, {
    REDLINE_ABANDON_MS: "1000",
  });
  await waitForServer(port);

  const startupPath = path.join(
    dir,
    ".review",
    path.basename(filePath) + ".startup.json",
  );
  expect(existsSync(startupPath)).toBe(true);

  // Trip the abandon timer the same way the tab-close test does.
  const closeEvents = await openBrowserEvents(port);
  await closeEvents();

  await waitForExit(proc, 5000);
  expect(existsSync(startupPath)).toBe(false);
}, 15_000);

// Note: SIGINT/SIGTERM signal handling is not testable via Bun.spawn's proc.kill() —
// the OS terminates the subprocess before the JS handler can run. Verified manually:
// Ctrl+C exits with code 2 and writes the abandoned result file correctly.
// The abandon() code path itself is exercised by the tab-close timer test below.

test("tab-close triggers abandon after grace period", async () => {
  const { filePath, dir } = createTestFile();
  const { proc, port } = await spawnTracked(filePath, {
    REDLINE_ABANDON_MS: "1000",
  });
  await waitForServer(port);

  // Connect as a browser client, then disconnect
  const closeEvents = await openBrowserEvents(port);
  await closeEvents(); // disconnect — triggers hadBrowser timer

  const code = await waitForExit(proc, 5000);

  expect(code).toBe(2);
  const result = await readResult(dir);
  expect(result.status).toBe("abandoned");
}, 15_000);

test("revision crash → abandon writes error result, not abandoned", async () => {
  const { filePath, dir } = createTestFile();
  const { proc, port } = await spawnTracked(filePath, {
    REDLINE_ABANDON_MS: "1000",
  });
  await waitForServer(port);

  // Simulate a revision crash: agent posts /api/revision-error with the failure reason.
  const errRes = await fetch(`http://localhost:${port}/api/revision-error`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({ message: "claude CLI exited with code 1 — boom" }),
  });
  expect(errRes.status).toBe(200);

  // Connect a browser then drop it, tripping the abandon timer.
  const closeEvents = await openBrowserEvents(port);
  await closeEvents();

  const code = await waitForExit(proc, 5000);
  expect(code).toBe(3);

  const result = await readResult(dir);
  expect(result.status).toBe("error");
  expect(result.reason).toContain("boom");
}, 15_000);

test("abandon path carries escalations into the result file", async () => {
  // Author-needed feedback must survive a session that ends on abandon, not just a clean
  // finish — otherwise feedback meant for the authoring agent is lost when a
  // review is interrupted.
  const { filePath, dir } = createTestFile();
  const { proc, port } = await spawnTracked(
    filePath,
    { REDLINE_ABANDON_MS: "1000" },
    ["--no-agent"],
  );
  await waitForServer(port);

  const c = await postComment(
    port,
    { quote: "a test" },
    "Check this against the house style guide.",
  );
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

  // Connect a browser then drop it, tripping the abandon timer.
  const closeEvents = await openBrowserEvents(port);
  await closeEvents();

  const code = await waitForExit(proc, 5000);
  expect(code).toBe(2);

  const result = await readResult(dir);
  expect(result.status).toBe("abandoned");
  const escalations = result.escalations as Array<Record<string, unknown>>;
  expect(escalations).toHaveLength(1);
  expect(escalations[0]!.quote).toBe("a test");
}, 15_000);

test("revision crash → recovered → abandon writes abandoned, not error", async () => {
  const { filePath, dir } = createTestFile();
  const { proc, port } = await spawnTracked(filePath, {
    REDLINE_ABANDON_MS: "1000",
  });
  await waitForServer(port);

  // Crash...
  await fetch(`http://localhost:${port}/api/revision-error`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({ message: "boom" }),
  });
  // ...then a successful revision lands (clears the error).
  await fetch(`http://localhost:${port}/api/reload`, {
    method: "POST",
    headers: CSRF_HEADERS,
  });

  const closeEvents = await openBrowserEvents(port);
  await closeEvents();

  const code = await waitForExit(proc, 5000);
  expect(code).toBe(2);
  const result = await readResult(dir);
  expect(result.status).toBe("abandoned");
}, 15_000);

test("brief disconnect-reconnect within grace does NOT trip abandon", async () => {
  const { filePath } = createTestFile();
  // 2s grace gives us a window to disconnect, reconnect, and outlast the original timer
  const { proc, port } = await spawnTracked(filePath, {
    REDLINE_ABANDON_MS: "2000",
  });
  await waitForServer(port);

  // First connection
  const closeEvents1 = await openBrowserEvents(port);

  // Drop it briefly — starts the abandon timer (2s)
  await closeEvents1();
  await Bun.sleep(500);

  // Reconnect well within the grace — should cancel the timer
  const closeEvents2 = await openBrowserEvents(port);

  // Wait past the original 2s grace window. If the timer wasn't cancelled, the server would have exited.
  await Bun.sleep(2500);

  // Verify still alive: the HTTP endpoint responds.
  const res = await fetch(`http://localhost:${port}/api/comments`);
  expect(res.ok).toBe(true);

  // Cleanup
  await closeEvents2();
}, 15_000);

test("tab-closed beacon abandons on the short grace even when the backstop is long", async () => {
  const { filePath, dir } = createTestFile();
  // Long backstop (60s) — a bare SSE drop would NOT abandon within this test's
  // window. The explicit beacon must take the short TAB_CLOSE_GRACE_MS path.
  const { proc, port } = await spawnTracked(filePath, {
    REDLINE_ABANDON_MS: "60000",
    REDLINE_TABCLOSE_MS: "800",
  });
  await waitForServer(port);

  const closeEvents = await openBrowserEvents(port);

  // Tab fires its close beacon, then the SSE drops — the order a real close hits.
  await fetch(`http://localhost:${port}/api/tab-closed`, {
    method: "POST",
    headers: CSRF_HEADERS,
  });
  await closeEvents();

  const code = await waitForExit(proc, 5000);
  expect(code).toBe(2);
  const result = await readResult(dir);
  expect(result.status).toBe("abandoned");
}, 15_000);

test("tab-closed beacon followed by a reconnect (reload) does NOT abandon", async () => {
  const { filePath } = createTestFile();
  const { proc, port } = await spawnTracked(filePath, {
    REDLINE_ABANDON_MS: "60000",
    REDLINE_TABCLOSE_MS: "1500",
  });
  await waitForServer(port);

  const closeEvents1 = await openBrowserEvents(port);

  // Reload: beacon fires, old SSE drops, new SSE reconnects within the short grace.
  await fetch(`http://localhost:${port}/api/tab-closed`, {
    method: "POST",
    headers: CSRF_HEADERS,
  });
  await closeEvents1();
  await Bun.sleep(300);
  const closeEvents2 = await openBrowserEvents(port);

  // Outlast the short grace; the reconnect should have cancelled the timer.
  await Bun.sleep(2000);
  const res = await fetch(`http://localhost:${port}/api/comments`);
  expect(res.ok).toBe(true);

  await closeEvents2();
}, 15_000);

test("--context flag persists to sidecar.context on first run", async () => {
  // The CLI parses --context and threads it to createServer, which writes
  // it to the sidecar on startup. From there agent.ts and resolve.ts both
  // load it and prepend a "Reviewer's stated focus" block to their prompts.
  // This test covers the CLI → server → sidecar leg; the prompt-injection
  // leg is covered by unit tests on contextBlock.
  const { filePath, dir } = createTestFile();
  const ctx = "Reviewing for technical accuracy, not prose style.";
  const { port } = await spawnTracked(filePath, {}, ["--context", ctx]);
  await waitForServer(port);

  // Server's startup hook writes context into the sidecar asynchronously;
  // poll briefly so the assertion isn't racing the write.
  const sidecarPath = path.join(
    dir,
    ".review",
    path.basename(filePath) + ".json",
  );
  let sidecar: any = null;
  for (let i = 0; i < 20; i++) {
    if (existsSync(sidecarPath)) {
      try {
        sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));
        if (sidecar.context) break;
      } catch {
        /* mid-write, retry */
      }
    }
    await Bun.sleep(50);
  }
  expect(sidecar).not.toBeNull();
  expect(sidecar.context).toBe(ctx);
}, 15_000);

test("--no-agent skips agent spawn, server stays usable, page reports manual mode", async () => {
  // The whole point of --no-agent: lightweight Markdown annotation without
  // requiring claude on PATH or paying for a subprocess. The server still
  // accepts comments and resolves; the agent is just absent.
  const { filePath } = createTestFile();
  const { port, agentReady } = await spawnTracked(filePath, {}, ["--no-agent"]);
  await waitForServer(port);

  // The agent was never spawned, so its "[agent] connected" line never
  // arrives — agentReady should still be unresolved well past the window
  // a real spawn would settle in.
  let agentConnected = false;
  agentReady.then(() => {
    agentConnected = true;
  });
  await Bun.sleep(750);
  expect(agentConnected).toBe(false);

  // Server still serves comments end-to-end; CSRF still required.
  const post = await fetch(`http://localhost:${port}/api/comment`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({
      quote: "first paragraph",
      context_before: "",
      context_after: "",
      message: "manual note",
    }),
  });
  expect(post.status).toBe(200);

  // The rendered page bootstraps noAgent:true into window.__REDLINE__ and
  // shows the Manual mode pill. Inline-grep the HTML rather than spinning
  // up a real browser — the bootstrap is what the client actually reads.
  const html = await fetch(`http://localhost:${port}/`).then((r) => r.text());
  expect(html).toContain("noAgent: true");
  expect(html).toContain("Manual mode");
}, 15_000);

test("caller responder routes ordinary comments to the launching agent", async () => {
  const { filePath, dir } = createTestFile();
  const { port, agentReady } = await spawnTracked(filePath, {}, [
    "--responder",
    "caller",
  ]);

  let agentConnected = false;
  agentReady.then(() => {
    agentConnected = true;
  });
  await Bun.sleep(250);
  expect(agentConnected).toBe(false);

  const startupPath = path.join(dir, ".review", "test.md.startup.json");
  const startup = JSON.parse(readFileSync(startupPath, "utf-8"));
  expect(startup.responder_mode).toBe("caller");

  const comment = await postComment(
    port,
    { quote: "test" },
    "Why did we choose this architecture?",
  );
  const pending = await waitForAuthorEvent(filePath, {
    intervalMs: 50,
    timeoutMs: 1_000,
  });
  expect(pending.kind).toBe("caller-turn");
  if (pending.kind !== "caller-turn") throw new Error("caller turn missing");
  expect(pending.caller_turns[0]!.commentId).toBe(comment.id);

  await Bun.sleep(250);
  let saved = JSON.parse(
    readFileSync(path.join(dir, ".review", "test.md.json"), "utf-8"),
  );
  expect(saved.responder_mode).toBe("caller");
  expect(saved.rounds[0].comments[0].thread).toHaveLength(1);

  const reply = await postAuthorReply(
    filePath,
    comment.id,
    "The process boundary kept the real-time event loop independent.",
    { name: "Codex", requiresRevision: false },
  );
  expect(reply.via).toBe("server");

  saved = JSON.parse(
    readFileSync(path.join(dir, ".review", "test.md.json"), "utf-8"),
  );
  expect(saved.rounds[0].comments[0].thread.at(-1)).toMatchObject({
    author: true,
    name: "Codex",
    requires_revision: false,
  });
}, 15_000);

test("caller lease loss is explicit and a heartbeat clears it", async () => {
  const { filePath } = createTestFile();
  const { port } = await spawnTracked(
    filePath,
    { REDLINE_CALLER_LEASE_MS: "500" },
    ["--responder", "caller"],
  );

  const unavailable = waitForEvent(port, "responder-unavailable", {
    timeoutMs: 2_000,
  });
  await unavailable.ready;
  const lost = await unavailable;
  expect(lost.data.mode).toBe("caller");
  expect(lost.data.reason).toContain("stopped checking in");

  const available = waitForEvent(port, "responder-available", {
    timeoutMs: 1_000,
  });
  await available.ready;
  const heartbeat = await fetch(
    `http://localhost:${port}/api/caller-heartbeat`,
    { method: "POST", headers: CSRF_HEADERS },
  );
  expect(heartbeat.status).toBe(200);
  expect((await available).data.mode).toBe("caller");
}, 15_000);

test("explicit caller-to-local takeover recovers an unanswered turn", async () => {
  const { filePath, dir } = createTestFile();
  const claude = installClaudeShim(dir);
  const session = await spawnTracked(
    filePath,
    {
      REDLINE_AGENT: "claude",
      CLAUDE_CODE_EXECPATH: claude,
      REDLINE_SHIM_REPLY:
        "REQUIRES_REVISION: false\nESCALATE: false\nREASON:\n---MESSAGE---\nRecovered locally.\n---END---",
    },
    ["--responder", "caller"],
  );
  const comment = await postComment(
    session.port,
    { quote: "test" },
    "Please answer after takeover.",
  );

  const changed = waitForEvent(session.port, "responder-changed", {
    timeoutMs: 2_000,
  });
  await changed.ready;
  const command = Bun.spawn(
    [BUN, "run", CLI, "responder", filePath, "--mode", "local"],
    { stdout: "pipe", stderr: "pipe", env: TEST_ENV },
  );
  expect(await command.exited).toBe(0);
  expect(await new Response(command.stdout).text()).toContain(
    "Responder switched to local",
  );
  expect((await changed).data.mode).toBe("local");
  await session.waitForAgentConnects(1);

  const deadline = Date.now() + 3_000;
  let saved: any;
  do {
    saved = JSON.parse(
      readFileSync(path.join(dir, ".review", "test.md.json"), "utf-8"),
    );
    if (saved.rounds[0].comments[0].thread.length > 1) break;
    await Bun.sleep(50);
  } while (Date.now() < deadline);

  expect(saved.responder_mode).toBe("local");
  expect(saved.rounds[0].comments[0].id).toBe(comment.id);
  expect(saved.rounds[0].comments[0].thread.at(-1)).toMatchObject({
    role: "agent",
    message: "Recovered locally.",
    requires_revision: false,
  });
}, 15_000);

test("relaunching a stale caller revision in manual mode restores the round", async () => {
  const { filePath, dir } = createTestFile();
  const reviewDir = path.join(dir, ".review");
  const pendingDir = path.join(reviewDir, "pending");
  mkdirSync(pendingDir, { recursive: true });
  const candidate = path.join(pendingDir, "test.md.round-1.md");
  writeFileSync(candidate, "# staged\n");
  writeFileSync(
    path.join(reviewDir, "test.md.json"),
    JSON.stringify({
      file: "test.md",
      responder_mode: "caller",
      pending_revision: {
        round: 1,
        candidate_file: candidate,
        source_hash: "stale",
        prepared_at: "prepared",
      },
      rounds: [
        {
          round: 1,
          started_at: "started",
          submitted_at: null,
          agent_replied_at: null,
          resolved_at: "accepted",
          caller_revision_requested_at: "requested",
          comments: [],
        },
      ],
    }),
  );

  const { port } = await spawnTracked(filePath, {}, ["--responder", "manual"]);
  await waitForServer(port);
  const saved = JSON.parse(
    readFileSync(path.join(reviewDir, "test.md.json"), "utf-8"),
  );
  expect(saved.responder_mode).toBe("manual");
  expect(saved.pending_revision).toBeUndefined();
  expect(saved.rounds).toHaveLength(1);
  expect(saved.rounds[0].resolved_at).toBeNull();
  expect(saved.rounds[0].caller_revision_requested_at).toBeUndefined();
  expect(existsSync(candidate)).toBe(false);
}, 15_000);

test("caller responder validates and commits a staged revision", async () => {
  const source =
    "# Test Document\n\nThis is a test.\n\n## Untouched\n\nKeep this section.\n";
  const { filePath, dir } = createTestFile(source);
  const { port } = await spawnTracked(filePath, {}, ["--responder", "caller"]);
  const comment = await postComment(
    port,
    { quote: "This is a test." },
    "Make this claim more concrete.",
  );
  await waitForAuthorEvent(filePath, { intervalMs: 50, timeoutMs: 1_000 });
  await postAuthorReply(
    filePath,
    comment.id,
    "I’ll name the behavior directly.",
    {
      requiresRevision: true,
      revisionReason: "Replace the generic test sentence with concrete copy",
    },
  );
  await fetch(`http://localhost:${port}/api/comment/${comment.id}/resolve`, {
    method: "POST",
    headers: CSRF_HEADERS,
  });

  await fetch(`http://localhost:${port}/api/accept`, {
    method: "POST",
    headers: CSRF_HEADERS,
  });
  const request = await waitForAuthorEvent(filePath, {
    intervalMs: 50,
    timeoutMs: 1_000,
  });
  expect(request.kind).toBe("revision-request");
  if (request.kind !== "revision-request") {
    throw new Error("revision request missing");
  }
  expect(request.revision.round).toBe(1);
  expect(readFileSync(request.revision.revision_file, "utf-8")).toBe(source);
  writeFileSync(
    request.revision.revision_file,
    source.replace(
      "This is a test.",
      "This review keeps the author in context.",
    ),
  );

  const reload = waitForEvent(port, "reload", { timeoutMs: 2_000 });
  await reload.ready;
  const completed = await completeCallerRevision(filePath, 1);
  await reload;

  expect(completed).toEqual({ changed: true, round: 1 });
  expect(readFileSync(filePath, "utf-8")).toContain(
    "This review keeps the author in context.",
  );
  const saved = JSON.parse(
    readFileSync(path.join(dir, ".review", "test.md.json"), "utf-8"),
  );
  expect(saved.pending_revision).toBeUndefined();
  expect(saved.rounds).toHaveLength(2);
  expect(saved.rounds[1].resolved_at).toBeNull();
  expect(readdirSync(path.join(dir, ".review", "history"))).toHaveLength(1);
}, 15_000);

test("caller revision rejection leaves the live document untouched", async () => {
  const source =
    "# Test Document\n\n## Editable\n\nChange this.\n\n## Untouched\n\nKeep this section.\n";
  const { filePath, dir } = createTestFile(source);
  const { port } = await spawnTracked(filePath, {}, ["--responder", "caller"]);
  const comment = await postComment(
    port,
    { quote: "Change this." },
    "Rewrite this sentence.",
  );
  await waitForAuthorEvent(filePath, { intervalMs: 50, timeoutMs: 1_000 });
  await postAuthorReply(filePath, comment.id, "I’ll rewrite it.", {
    requiresRevision: true,
    revisionReason: "Rewrite the editable sentence",
  });
  await fetch(`http://localhost:${port}/api/comment/${comment.id}/resolve`, {
    method: "POST",
    headers: CSRF_HEADERS,
  });
  await fetch(`http://localhost:${port}/api/accept`, {
    method: "POST",
    headers: CSRF_HEADERS,
  });
  const request = await waitForAuthorEvent(filePath, {
    intervalMs: 50,
    timeoutMs: 1_000,
  });
  if (request.kind !== "revision-request") {
    throw new Error("revision request missing");
  }
  writeFileSync(
    request.revision.revision_file,
    "# Test Document\n\n## Editable\n\nChanged.\n",
  );

  const revisionError = waitForEvent(port, "revision-error", {
    timeoutMs: 2_000,
  });
  await revisionError.ready;
  await expect(completeCallerRevision(filePath, 1)).rejects.toThrow(
    /dropped section/,
  );
  await revisionError;

  expect(readFileSync(filePath, "utf-8")).toBe(source);
  const saved = JSON.parse(
    readFileSync(path.join(dir, ".review", "test.md.json"), "utf-8"),
  );
  expect(saved.pending_revision).toBeUndefined();
  expect(saved.rounds[0].resolved_at).toBeNull();
}, 15_000);

test("agent restart cap → cli broadcasts agent-unavailable end-to-end", async () => {
  // End-to-end coverage of the dead-agent indicator: the agent's
  // crash-always hook makes every spawn exit non-zero; with the cap lowered
  // to 2 (defaults to 5), the cli gives up after the third crash and posts
  // /api/agent-unavailable. Subscribing first closes the broadcast race —
  // the event must land within the test timeout.
  const { filePath } = createTestFile();
  const { port } = await spawnTracked(filePath, {
    REDLINE_AGENT_CRASH_ALWAYS: "1",
    REDLINE_MAX_RESTARTS: "2",
  });
  await waitForServer(port);

  const ev = waitForEvent(port, "agent-unavailable", { timeoutMs: 8000 });
  await ev.ready;
  const result = await ev;

  expect(result.event).toBe("agent-unavailable");
  expect(typeof result.data.reason).toBe("string");
  // The cli's give-up message names the crash count and window, so this
  // doubles as a check that the reason flowed through end-to-end (cli →
  // server → SSE → subscriber) rather than the server's default fallback.
  expect(result.data.reason).toMatch(/crashed/i);
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
  const [sa, sb] = await Promise.all([
    spawnTracked(a.filePath),
    spawnTracked(b.filePath),
  ]);
  await Promise.all([waitForServer(sa.port), waitForServer(sb.port)]);

  // Fire both SIGTERMs as close to simultaneous as the runtime allows.
  process.kill(sa.proc.pid!, "SIGTERM");
  process.kill(sb.proc.pid!, "SIGTERM");

  const [aCode, bCode] = await Promise.all([
    waitForExit(sa.proc, 5000),
    waitForExit(sb.proc, 5000),
  ]);
  expect(aCode).toBe(2);
  expect(bCode).toBe(2);

  const [aRes, bRes] = await Promise.all([
    readResult(a.dir),
    readResult(b.dir),
  ]);
  expect(aRes.status).toBe("abandoned");
  expect(bRes.status).toBe("abandoned");
}, 20_000);

test("/api/finish writes approved result file and exits 0", async () => {
  const { filePath, dir } = createTestFile();
  const { proc, port } = await spawnTracked(filePath);
  await waitForServer(port);

  // Server auto-creates an open round on startup — /api/finish should work
  const res = await fetch(`http://localhost:${port}/api/finish`, {
    method: "POST",
    headers: CSRF_HEADERS,
  });
  expect(res.status).toBe(200);

  const code = await waitForExit(proc, 5000);

  expect(code).toBe(0);
  const result = await readResult(dir);
  expect(result.status).toBe("approved");
  expect(result.file).toBe(filePath);
  expect(typeof result.rounds).toBe("number");
  expect(typeof result.comments).toBe("number");
}, 15_000);

test("/api/finish: author-needed comment surfaces in the result file escalations array", async () => {
  // --no-agent so no claude shim is needed; we post the author-needed agent reply
  // directly. Exercises the closeout path: sidecar → reviewSummary → result file.
  const { filePath, dir } = createTestFile();
  const { proc, port } = await spawnTracked(filePath, {}, ["--no-agent"]);
  await waitForServer(port);

  const c = await postComment(
    port,
    { quote: "a test" },
    "Run this past the house style guide.",
  );
  await fetch(`http://localhost:${port}/api/comment/${c.id}/reply`, {
    method: "POST",
    headers: CSRF_JSON_HEADERS,
    body: JSON.stringify({
      role: "agent",
      name: "Claude",
      message: "I don't have the style guide — an author reply is needed.",
      requires_revision: false,
      escalate: true,
    }),
  });

  const res = await fetch(`http://localhost:${port}/api/finish`, {
    method: "POST",
    headers: CSRF_HEADERS,
  });
  expect(res.status).toBe(200);

  const code = await waitForExit(proc, 5000);
  expect(code).toBe(0);

  const result = await readResult(dir);
  expect(result.status).toBe("approved");
  const escalations = result.escalations as Array<Record<string, unknown>>;
  expect(Array.isArray(escalations)).toBe(true);
  expect(escalations).toHaveLength(1);
  expect(escalations[0]!.quote).toBe("a test");
  expect(escalations[0]!.request).toBe("Run this past the house style guide.");
}, 15_000);

test("/api/finish: no escalations → result file carries an empty escalations array", async () => {
  const { filePath, dir } = createTestFile();
  const { proc, port } = await spawnTracked(filePath, {}, ["--no-agent"]);
  await waitForServer(port);

  const res = await fetch(`http://localhost:${port}/api/finish`, {
    method: "POST",
    headers: CSRF_HEADERS,
  });
  expect(res.status).toBe(200);

  const code = await waitForExit(proc, 5000);
  expect(code).toBe(0);

  const result = await readResult(dir);
  expect(result.escalations).toEqual([]);
}, 15_000);
