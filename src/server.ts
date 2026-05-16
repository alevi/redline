import { Hono } from "hono";
import { readFile, realpath } from "fs/promises";
import path from "path";
import { renderMarkdown, renderMessageMarkdown } from "./render";
import { renderDocDiff } from "./diff";
import { pageTemplate } from "./server-page";
import {
  loadSidecar,
  saveSidecar,
  withSidecar,
  getOrCreateActiveRound,
  activeRound,
  type Comment,
} from "./sidecar";

// Attach a sanitized HTML rendering of each thread message so the client
// can show markdown formatting (bold, lists, inline code) instead of the
// raw source. Done server-side because renderMarkdown depends on marked +
// sanitize-html which are Node-targeted. The HTML is added as a `messageHtml`
// field alongside the original `message` so callers that read the source
// (eg. agent prompt building) are unaffected.
export function serializeCommentsForClient(comments: Comment[]): unknown[] {
  return comments.map((c) => ({
    ...c,
    thread: c.thread.map((e) => ({
      ...e,
      messageHtml: renderMessageMarkdown(e.message),
    })),
  }));
}

// Bundle the client JS once per server lifetime. The build is ~50-100ms — felt
// only at server startup, not on page loads (the bundle is cached in memory)
// and not when the source file is re-read. See M10 for the on-disk cache idea.
let clientBundlePromise: Promise<string> | null = null;
function getClientBundle(): Promise<string> {
  if (!clientBundlePromise) {
    clientBundlePromise = (async () => {
      const entrypoint = path.resolve(import.meta.dir, "client/main.ts");
      const result = await Bun.build({ entrypoints: [entrypoint], target: "browser", minify: false });
      if (!result.success) {
        const errs = result.logs.map((l) => l.message).join("\n");
        throw new Error("client bundle failed to build:\n" + errs);
      }
      return await result.outputs[0]!.text();
    })();
  }
  return clientBundlePromise;
}

export function createServer(
  filePath: string,
  opts: { context?: string; csrfToken?: string; noAgent?: boolean; agentName?: string } = {}
) {
  const app = new Hono();
  const fileName = path.basename(filePath);

  // CSRF token. Issued at server start, embedded in the rendered page, passed
  // to the agent subprocess via env, required as `X-Redline-Token` on every
  // mutating /api request. Defends against a malicious page in another tab
  // firing no-cors POSTs at the loopback server — a custom request header
  // forces a CORS preflight that the server doesn't honor, so the actual POST
  // never lands. The browser's same-origin policy already blocks reads cross-
  // origin; the token closes the write side.
  const csrfToken = opts.csrfToken ?? crypto.randomUUID();

  app.use("/api/*", async (c, next) => {
    const m = c.req.method;
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
    const got = c.req.header("X-Redline-Token");
    if (got !== csrfToken) {
      return new Response("forbidden: missing or wrong X-Redline-Token", { status: 403 });
    }
    return next();
  });

  // Kick off the bundle build immediately so it's ready by the time the
  // browser hits /. In practice the build finishes long before the browser
  // requests /client.js, but await it on the route just in case.
  getClientBundle().catch((err) => console.error("client bundle build error:", err));

  app.get("/client.js", async (c) => {
    const js = await getClientBundle();
    return new Response(js, {
      headers: { "Content-Type": "application/javascript; charset=utf-8" },
    });
  });

  // Serve extracted CSS — read once and cache in memory like the JS bundle.
  let cssCache: string | null = null;
  app.get("/styles.css", async (c) => {
    if (!cssCache) {
      cssCache = await readFile(path.resolve(import.meta.dir, "client/styles.css"), "utf-8");
    }
    return new Response(cssCache, {
      headers: { "Content-Type": "text/css; charset=utf-8" },
    });
  });

  // On startup, ensure there is always an open round to receive comments
  (async () => {
    await withSidecar(filePath, (sidecar) => {
      let changed = false;
      const hasOpen = sidecar.rounds.some((r: any) => r.resolved_at === null);
      if (!hasOpen) {
        sidecar.rounds.push({
          round: sidecar.rounds.length + 1,
          started_at: new Date().toISOString(),
          submitted_at: null,
          agent_replied_at: null,
          resolved_at: null,
          comments: [],
        });
        changed = true;
      }
      if (opts.context && !sidecar.context) {
        sidecar.context = opts.context;
        changed = true;
      }
      // Skip the save if there's nothing to write.
      if (!changed) return false as const;
    });
  })();

  // ── SSE broadcast ────────────────────────────────────────────────────
  const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const browserClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();

  // Abandonment detection: if no browser is connected for ABANDON_GRACE_MS after
  // the first one ever connected, fire onAbandonCallback so the CLI can exit.
  // Default 10min — this is now only the *backstop* for the no-beacon case
  // (browser crash, kill -9, OS-killed tab). A cleanly closed tab fires an
  // explicit /api/tab-closed beacon and takes the much shorter TAB_CLOSE_GRACE_MS
  // path instead. The long backstop must stay generous: a bare SSE drop (laptop
  // sleep, network blip, DevTools offline) is NOT a closed tab, and exiting on
  // it kills a session the user means to continue. Override with
  // REDLINE_ABANDON_MS for tests.
  const ABANDON_GRACE_MS = process.env.REDLINE_ABANDON_MS
    ? parseInt(process.env.REDLINE_ABANDON_MS, 10)
    : 10 * 60 * 1000;
  // Grace applied after an explicit tab-close beacon. A reload also fires the
  // beacon, so we can't exit immediately — but a reload reconnects its SSE
  // within ~1s, while a real close never does. A few seconds covers the
  // reconnect. Override with REDLINE_TABCLOSE_MS for tests.
  const TAB_CLOSE_GRACE_MS = process.env.REDLINE_TABCLOSE_MS
    ? parseInt(process.env.REDLINE_TABCLOSE_MS, 10)
    : 8000;
  let hadBrowser = false;
  let abandonTimer: ReturnType<typeof setTimeout> | null = null;
  let onAbandonCallback: (() => void) | undefined;
  let onFinishedCallback: ((payload: { totalRounds: number; totalComments: number }) => void) | undefined;
  let onRevisionErrorCallback: ((message: string) => void) | undefined;
  let onRevisionRecoveredCallback: (() => void) | undefined;

  // Revision watchdog: when /api/accept fires we start a timer. If no terminal
  // event (/api/reload, /api/revision-no-changes, /api/revision-error) arrives
  // within REVISION_TIMEOUT_MS, we assume the resolve flow is wedged and
  // surface a `revision-stalled` event so the user can recover. The round is
  // also un-resolved so clicking Revise again is meaningful.
  const REVISION_TIMEOUT_MS = process.env.REDLINE_REVISION_TIMEOUT_MS
    ? parseInt(process.env.REDLINE_REVISION_TIMEOUT_MS, 10)
    : 3 * 60 * 1000;
  let revisionWatchdog: ReturnType<typeof setTimeout> | null = null;
  // Token bumped on every clear/start. The async setTimeout callback compares
  // against this token before mutating the sidecar and broadcasting — a
  // /api/reload that arrives between "timer fires" and "callback finishes its
  // await" must NOT have its un-resolve / revision-stalled side effects land,
  // because the round is already legitimately resolved by the new revision.
  // Without the token, the watchdog and reload race: clearTimeout on an
  // already-fired timer is a no-op, so the in-flight callback completes its
  // sidecar mutation and broadcasts a spurious revision-stalled event.
  let revisionWatchdogId = 0;
  function clearRevisionWatchdog() {
    if (revisionWatchdog) { clearTimeout(revisionWatchdog); revisionWatchdog = null; }
    revisionWatchdogId += 1;
  }
  function startRevisionWatchdog() {
    clearRevisionWatchdog();
    const myId = revisionWatchdogId;
    revisionWatchdog = setTimeout(async () => {
      revisionWatchdog = null;
      const reason = `revision did not complete within ${REVISION_TIMEOUT_MS / 1000}s`;
      console.error(`[redline] ${reason} — un-resolving round and notifying browser.`);
      try {
        await withSidecar(filePath, (sidecar) => {
          // Re-check inside the lock: another endpoint may have bumped
          // revisionWatchdogId after this callback was queued (the race the
          // token is here to close).
          if (myId !== revisionWatchdogId) return false as const;
          const lastResolved = [...sidecar.rounds].reverse().find((r) => r.resolved_at !== null);
          if (!lastResolved) return false as const;
          lastResolved.resolved_at = null;
        });
      } catch (e) {
        console.error("[redline] watchdog: failed to un-resolve round:", e);
      }
      // Same race-check before broadcasting + telling the calling agent: if
      // /api/reload landed first, this watchdog is stale and silent.
      if (myId !== revisionWatchdogId) return;
      broadcast("revision-stalled", { message: reason });
      // Same recovery semantics as a revision crash — calling agent should see
      // the session as errored if it abandons in this state.
      onRevisionErrorCallback?.(reason);
    }, REVISION_TIMEOUT_MS);
  }

  function armAbandonTimer(graceMs: number) {
    if (abandonTimer) clearTimeout(abandonTimer);
    abandonTimer = setTimeout(() => {
      abandonTimer = null;
      // Re-check at fire time: a tab may have (re)connected during the grace
      // — a reload, or a second tab — in which case nothing is abandoned.
      if (browserClients.size > 0) return;
      console.log(`\n[redline] No browser connected for ${graceMs / 1000}s — assuming abandoned.`);
      onAbandonCallback?.();
    }, graceMs);
  }

  function checkBrowserPresence() {
    if (browserClients.size > 0) {
      hadBrowser = true;
      if (abandonTimer) { clearTimeout(abandonTimer); abandonTimer = null; }
    } else if (hadBrowser && !abandonTimer) {
      armAbandonTimer(ABANDON_GRACE_MS);
    }
  }

  function broadcast(event: string, data: Record<string, unknown> = {}) {
    const msg = enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const ctrl of sseClients) {
      try { ctrl.enqueue(msg); } catch { sseClients.delete(ctrl); browserClients.delete(ctrl); }
    }
  }

  app.get("/api/events", (c) => {
    const isBrowser = new URL(c.req.url).searchParams.get("client") === "browser";
    let ctrl: ReadableStreamDefaultController<Uint8Array>;
    let keepaliveTimer: ReturnType<typeof setInterval>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrl = controller;
        sseClients.add(controller);
        if (isBrowser) { browserClients.add(controller); checkBrowserPresence(); }
        controller.enqueue(enc.encode(": connected\n\n"));
        keepaliveTimer = setInterval(() => {
          try { controller.enqueue(enc.encode(": ping\n\n")); }
          catch { clearInterval(keepaliveTimer); sseClients.delete(controller); browserClients.delete(controller); checkBrowserPresence(); }
        }, 8000);
      },
      cancel() {
        clearInterval(keepaliveTimer);
        sseClients.delete(ctrl);
        browserClients.delete(ctrl);
        checkBrowserPresence();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  });

  app.get("/", async (c) => {
    const content = await readFile(filePath, "utf-8");
    const html = renderMarkdown(content);
    const sidecar = await loadSidecar(filePath);
    const round = activeRound(sidecar);
    const latestRound = sidecar.rounds[sidecar.rounds.length - 1] ?? null;
    const comments = latestRound?.comments ?? [];
    const roundResolved = latestRound?.resolved_at != null;
    const agentRepliedAt = latestRound?.agent_replied_at ?? null;
    const roundNumber = latestRound?.round ?? 1;
    const totalRounds = sidecar.rounds.length;
    return c.html(pageTemplate(fileName, html, serializeCommentsForClient(comments), roundResolved, agentRepliedAt, roundNumber, totalRounds, sidecar.context, false, csrfToken, opts.noAgent ?? false, opts.agentName));
  });

  // Add a comment to the active round
  app.post("/api/comment", async (c) => {
    const body = await c.req.json<{
      quote: string;
      context_before: string;
      context_after: string;
      message: string;
    }>();

    const { comment, roundNumber } = await withSidecar(filePath, (sidecar) => {
      const round = getOrCreateActiveRound(sidecar);
      const comment: Comment = {
        // crypto.randomUUID() — collision-free without depending on
        // single-process timestamp resolution (the prior `c<Date.now()>
        // <random4>` shape relied on the 4-digit suffix to dodge per-ms
        // collisions, which gets statistically thin under any concurrency).
        id: `c${crypto.randomUUID()}`,
        quote: body.quote,
        context_before: body.context_before,
        context_after: body.context_after,
        thread: [
          { role: "human", message: body.message, at: new Date().toISOString() },
        ],
        resolved: false,
      };
      round.comments.push(comment);
      return { comment, roundNumber: round.round };
    });
    broadcast("comment-added", { round: roundNumber, commentId: comment.id });
    return c.json({ ok: true, comment });
  });

  // Mark a comment resolved
  app.post("/api/comment/:id/resolve", async (c) => {
    const id = c.req.param("id");
    const out = await withSidecar(filePath, (sidecar) => {
      const round = activeRound(sidecar);
      if (!round) return { skip: true as const, status: 400, error: "No active round" };
      const comment = round.comments.find((cm) => cm.id === id);
      if (!comment) return { skip: true as const, status: 404, error: "Comment not found" };
      comment.resolved = true;
      const allResolved = round.comments.length > 0 && round.comments.every((cm) => cm.resolved);
      return { skip: false as const, roundNumber: round.round, allResolved };
    });
    if (out.skip) return c.json({ ok: false, error: out.error }, out.status as 400 | 404);
    broadcast("comment-resolved", { round: out.roundNumber, commentId: id, allResolved: out.allResolved });
    return c.json({ ok: true, allResolved: out.allResolved });
  });

  // Reopen a resolved comment
  app.post("/api/comment/:id/reopen", async (c) => {
    const id = c.req.param("id");
    const out = await withSidecar(filePath, (sidecar) => {
      const latestRound = sidecar.rounds[sidecar.rounds.length - 1] ?? null;
      if (!latestRound) return { skip: true as const, status: 400, error: "No round found" };
      const comment = latestRound.comments.find((cm) => cm.id === id);
      if (!comment) return { skip: true as const, status: 404, error: "Comment not found" };
      comment.resolved = false;
      const allResolved = latestRound.comments.length > 0 && latestRound.comments.every((cm) => cm.resolved);
      return { skip: false as const, roundNumber: latestRound.round, allResolved, comment };
    });
    if (out.skip) return c.json({ ok: false, error: out.error }, out.status as 400 | 404);
    broadcast("comment-resolved", { round: out.roundNumber, commentId: id, allResolved: out.allResolved });
    return c.json({ ok: true, comment: out.comment });
  });

  // Submit for agent review — signals the agent to respond to comments
  app.post("/api/submit", async (c) => {
    const out = await withSidecar(filePath, (sidecar) => {
      const round = activeRound(sidecar);
      if (!round) return { skip: true as const, status: 400, error: "No active round" };
      if (round.comments.length === 0) return { skip: true as const, status: 400, error: "No comments to submit" };
      round.submitted_at = new Date().toISOString();
      round.agent_replied_at = null; // clear so agent knows to respond again
      return { skip: false as const, roundNumber: round.round, count: round.comments.length };
    });
    if (out.skip) return c.json({ ok: false, error: out.error }, out.status as 400);
    broadcast("submitted", { round: out.roundNumber, comments: out.count });
    return c.json({ ok: true });
  });

  // Accept & revise — human is done discussing; agent should now revise the document
  app.post("/api/accept", async (c) => {
    const out = await withSidecar(filePath, (sidecar) => {
      const round = activeRound(sidecar);
      if (!round) return { skip: true as const };
      round.resolved_at = new Date().toISOString();
      return { skip: false as const, roundNumber: round.round };
    });
    if (out.skip) return c.json({ ok: false, error: "No active round" }, 400);
    broadcast("accepted", { round: out.roundNumber });
    onRevisionRecoveredCallback?.();
    startRevisionWatchdog();
    return c.json({ ok: true });
  });

  // Finish a round with no comments — no revision needed, just close out
  app.post("/api/finish", async (c) => {
    const out = await withSidecar(filePath, (sidecar) => {
      const round = activeRound(sidecar);
      if (!round) return { skip: true as const };
      round.resolved_at = new Date().toISOString();
      const totalRounds = sidecar.rounds.filter((r: any) => r.resolved_at).length;
      const totalComments = sidecar.rounds.reduce((n: number, r: any) => n + (r.comments?.length ?? 0), 0);
      return { skip: false as const, roundNumber: round.round, totalRounds, totalComments };
    });
    if (out.skip) return c.json({ ok: false, error: "No active round" }, 400);
    broadcast("finished", { round: out.roundNumber });
    // Let the CLI handle the summary printout, result-file writing, and process exit.
    setTimeout(() => onFinishedCallback?.({ totalRounds: out.totalRounds, totalComments: out.totalComments }), 500);
    return c.json({ ok: true });
  });

  // Called by redline resolve after writing the revised document
  app.post("/api/reload", (c) => {
    clearRevisionWatchdog();
    broadcast("reload", {});
    onRevisionRecoveredCallback?.();
    return c.json({ ok: true });
  });

  // Called by redline resolve when the model returned no changes
  app.post("/api/revision-no-changes", (c) => {
    clearRevisionWatchdog();
    broadcast("revision-no-changes", {});
    onRevisionRecoveredCallback?.();
    return c.json({ ok: true });
  });

  // Called by redline resolve for each stdout chunk (streaming progress to browser)
  app.post("/api/revision-chunk", async (c) => {
    const { text, kind } = await c.req.json();
    broadcast("revision-chunk", { text, kind });
    return c.json({ ok: true });
  });

  // Called by the agent when the revision flow throws — un-resolves the latest
  // round so the human can retry by clicking "Revise document" again
  app.post("/api/revision-error", async (c) => {
    clearRevisionWatchdog();
    const { message } = await c.req.json();
    await withSidecar(filePath, (sidecar) => {
      const lastResolved = [...sidecar.rounds].reverse().find((r) => r.resolved_at !== null);
      if (!lastResolved) return false as const;
      lastResolved.resolved_at = null;
    });
    broadcast("revision-error", { message });
    onRevisionErrorCallback?.(message);
    return c.json({ ok: true });
  });

  // CLI signals the agent subprocess is gone for good (restart cap exhausted,
  // missing provider CLI, etc). Surfaces a small persistent indicator in the
  // header so the user knows replies aren't coming and can restart redline.
  // No paired "agent-available" event — recovery requires a restart, so the
  // indicator stays until the page reloads.
  app.post("/api/agent-unavailable", async (c) => {
    let reason = "Agent process unavailable.";
    try {
      const body = await c.req.json<{ reason?: string }>();
      if (body.reason?.trim()) reason = body.reason.trim();
    } catch { /* empty body is fine */ }
    broadcast("agent-unavailable", { reason });
    return c.json({ ok: true });
  });

  // A browser tab fired pagehide — it is closing, reloading, or navigating away.
  // This is a hint, not proof of abandonment (a reload fires it too), so we
  // shorten the abandon grace rather than exiting outright. On a real close the
  // SSE never reconnects and the short timer fires; on a reload the new page
  // reconnects within ~1s and checkBrowserPresence clears the timer. Crashes
  // and kill -9 send no beacon and fall back to the long ABANDON_GRACE_MS.
  app.post("/api/tab-closed", (c) => {
    if (hadBrowser) armAbandonTimer(TAB_CLOSE_GRACE_MS);
    return c.json({ ok: true });
  });

  // Agent signals it is composing a reply (shows typing indicator in thread)
  app.post("/api/comment/:id/thinking", async (c) => {
    const id = c.req.param("id");
    broadcast("comment-thinking", { commentId: id });
    return c.json({ ok: true });
  });

  // Post a reply to a comment thread (human or agent)
  app.post("/api/comment/:id/reply", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{
      message: string;
      role?: string;
      name?: string;
      requires_revision?: boolean;
      revision_reason?: string;
      escalate?: boolean;
      author?: boolean;
    }>();
    if (!body.message?.trim()) return c.json({ ok: false, error: "message is required" }, 400);
    const role = (body.role === "human" ? "human" : "agent") as "human" | "agent";
    const name = body.name?.trim() || undefined;

    const out = await withSidecar(filePath, (sidecar) => {
      const round = activeRound(sidecar);
      if (!round) return { skip: true as const, status: 400, error: "No active round" };
      const comment = round.comments.find((c) => c.id === id);
      if (!comment) return { skip: true as const, status: 404, error: "Comment not found" };
      const entry: import("./sidecar").ThreadEntry = { role, message: body.message.trim(), at: new Date().toISOString() };
      if (name) entry.name = name;
      // Verdict only meaningful on agent replies; ignore on human entries.
      if (role === "agent") {
        if (typeof body.requires_revision === "boolean") {
          entry.requires_revision = body.requires_revision;
          if (body.revision_reason?.trim()) entry.revision_reason = body.revision_reason.trim();
        }
        if (body.escalate === true) entry.escalate = true;
        if (body.author === true) entry.author = true;
      }
      comment.thread.push(entry);
      return { skip: false as const, roundNumber: round.round, comment };
    });
    if (out.skip) return c.json({ ok: false, error: out.error }, out.status as 400 | 404);
    if (role === "human" || (role === "agent" && body.author === true)) {
      broadcast("comment-reply", { round: out.roundNumber, commentId: id });
    }
    return c.json({ ok: true, comment: out.comment });
  });

  // Agent signals it has finished replying to all comments
  app.post("/api/agent-replied", async (c) => {
    const out = await withSidecar(filePath, (sidecar) => {
      const round = activeRound(sidecar);
      if (!round) return { skip: true as const };
      round.agent_replied_at = new Date().toISOString();
      return { skip: false as const, roundNumber: round.round };
    });
    if (out.skip) return c.json({ ok: false, error: "No active round" }, 400);
    broadcast("agent-replied", { round: out.roundNumber });
    return c.json({ ok: true });
  });

  // Keep /api/resolve as an alias for backward compat
  app.post("/api/resolve", async (c) => {
    const out = await withSidecar(filePath, (sidecar) => {
      const round = activeRound(sidecar);
      if (!round) return { skip: true as const, status: 400, error: "No active round" };
      if (round.comments.length === 0) return { skip: true as const, status: 400, error: "No comments to submit" };
      round.submitted_at = new Date().toISOString();
      return { skip: false as const };
    });
    if (out.skip) return c.json({ ok: false, error: out.error }, out.status as 400);
    return c.json({ ok: true });
  });

  // Live comments for the active round (used by client soft-refresh)
  app.get("/api/comments", async (c) => {
    const sidecar = await loadSidecar(filePath);
    const latestRound = sidecar.rounds[sidecar.rounds.length - 1] ?? null;
    return c.json({
      comments: serializeCommentsForClient(latestRound?.comments ?? []),
      roundResolved: latestRound?.resolved_at != null,
      totalRounds: sidecar.rounds.length,
    });
  });

  // Sidecar read (for agent polling)
  app.get("/api/sidecar", async (c) => {
    const sidecar = await loadSidecar(filePath);
    return c.json(sidecar);
  });

  // Read-only view of a past round
  app.get("/round/:n", async (c) => {
    const n = parseInt(c.req.param("n"));
    const sidecar = await loadSidecar(filePath);
    const roundData = sidecar.rounds.find((r) => r.round === n);
    if (!roundData) return c.text("Round not found", 404);

    // Find the history snapshot taken just before this round's revision
    // (snapshot saved before round n+1 starts = document state during round n)
    const historyDir = path.join(path.dirname(filePath), ".review", "history");
    const base = path.basename(filePath);
    let snapshots: string[] = [];
    try {
      const { readdir } = await import("fs/promises");
      const files = await readdir(historyDir);
      snapshots = files.filter((f) => f.startsWith(base + ".")).sort();
    } catch { /* no history */ }

    // Snapshot[n-1] (0-indexed, ascending sort) = document state during round n.
    // The first snapshot was saved just before round 2's revision overwrote round 1's file, etc.
    const snap = snapshots[n - 1];

    let docContent: string;
    if (snap) {
      const { readFile } = await import("fs/promises");
      docContent = await readFile(path.join(historyDir, snap), "utf-8");
    } else {
      // No snapshot — fall back to current file (round 1 with no prior history)
      docContent = await readFile(filePath, "utf-8");
    }

    const html = renderMarkdown(docContent);
    return c.html(pageTemplate(
      fileName,
      html,
      serializeCommentsForClient(roundData.comments),
      true,   // treat as resolved (read-only)
      roundData.agent_replied_at ?? null,
      n,
      sidecar.rounds.length,
      sidecar.context,
      true,   // readOnly
      csrfToken,
      opts.noAgent ?? false,
      opts.agentName
    ));
  });

  // Line diff between most recent history snapshot and current file
  app.get("/api/diff", async (c) => {
    const historyDir = path.join(path.dirname(filePath), ".review", "history");
    const base = path.basename(filePath);
    let snapshots: string[] = [];
    try {
      const { readdir } = await import("fs/promises");
      const files = await readdir(historyDir);
      snapshots = files
        .filter((f) => f.startsWith(base + "."))
        .sort()
        .reverse();
    } catch { /* no history dir yet */ }

    if (snapshots.length === 0) return c.json({ ok: false, error: "No history snapshot found" });

    const { readFile } = await import("fs/promises");
    const oldText = await readFile(path.join(historyDir, snapshots[0]), "utf-8");
    const newText = await readFile(filePath, "utf-8");
    const html = renderDocDiff(oldText, newText);
    return c.json({ ok: true, html });
  });

  // Static asset fallback: serve sibling files (images, etc.) from the doc's
  // directory so relative `![alt](./diagram.png)` works. Path-traversal guard:
  // resolved path must stay under the doc directory; the .review subdir is
  // off limits. Symlink guard: a `path.resolve` prefix check is sound against
  // `../foo` but not against a symlink IN the doc directory pointing outside
  // — the resolved path looks safe, but readFile follows the link. We re-
  // check after `realpath` so the *real* destination has to be inside docDir.
  app.get("*", async (c) => {
    const docDir = path.resolve(path.dirname(filePath));
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.notFound();
    }
    const requested = path.resolve(docDir, "." + urlPath);
    if (!requested.startsWith(docDir + path.sep) && requested !== docDir) return c.notFound();
    if (requested.startsWith(path.join(docDir, ".review") + path.sep)) return c.notFound();
    if (requested === path.resolve(filePath)) return c.notFound(); // the markdown itself is served at "/"

    // Resolve symlinks before reading. If `requested` is a symlink (or any
    // ancestor is) that points outside docDir, realpath returns the true
    // location and we reject. Also defends against the docDir itself being
    // symlinked, since we realpath docDir for the comparison.
    let realDocDir: string;
    let realRequested: string;
    try {
      realDocDir = await realpath(docDir);
      realRequested = await realpath(requested);
    } catch {
      // realpath errors when the path doesn't exist (404 territory) or when a
      // symlink target is missing (also 404). Either way: 404.
      return c.notFound();
    }
    if (!realRequested.startsWith(realDocDir + path.sep) && realRequested !== realDocDir) {
      return c.notFound();
    }

    try {
      const data = await readFile(realRequested);
      const ext = path.extname(realRequested).toLowerCase();
      const ct =
        ext === ".png" ? "image/png" :
        ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
        ext === ".gif" ? "image/gif" :
        ext === ".svg" ? "image/svg+xml" :
        ext === ".webp" ? "image/webp" :
        ext === ".pdf" ? "application/pdf" :
        "application/octet-stream";
      return new Response(data, { headers: { "Content-Type": ct, "Cache-Control": "no-cache" } });
    } catch {
      return c.notFound();
    }
  });

  return {
    fetch: app.fetch.bind(app),
    csrfToken,
    onAbandon(cb: () => void) { onAbandonCallback = cb; },
    onFinished(cb: (payload: { totalRounds: number; totalComments: number }) => void) {
      onFinishedCallback = cb;
    },
    onRevisionError(cb: (message: string) => void) { onRevisionErrorCallback = cb; },
    onRevisionRecovered(cb: () => void) { onRevisionRecoveredCallback = cb; },
  };
}
