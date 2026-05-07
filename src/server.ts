import { Hono } from "hono";
import { readFile } from "fs/promises";
import path from "path";
import { renderMarkdown } from "./render";
import { renderDocDiff } from "./diff";
import {
  loadSidecar,
  saveSidecar,
  withSidecar,
  getOrCreateActiveRound,
  activeRound,
  type Comment,
} from "./sidecar";

// Bundle the client JS once per server lifetime. The build is ~50-100ms — felt
// only at server startup, not on page loads (the bundle is cached in memory)
// and not when the source file is re-read. See M10 for the on-disk cache idea.
let clientBundlePromise: Promise<string> | null = null;
function getClientBundle(): Promise<string> {
  if (!clientBundlePromise) {
    clientBundlePromise = (async () => {
      const entrypoint = path.resolve(import.meta.dir, "client/main.js");
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

export function createServer(filePath: string, opts: { context?: string } = {}) {
  const app = new Hono();
  const fileName = path.basename(filePath);

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
  // Default 10min — DevTools-offline debugging, brief network blips, and tab
  // sleeps all reconnect well within that. The previous 2min default tripped on
  // routine offline-mode testing. Override with REDLINE_ABANDON_MS for tests.
  const ABANDON_GRACE_MS = process.env.REDLINE_ABANDON_MS
    ? parseInt(process.env.REDLINE_ABANDON_MS, 10)
    : 10 * 60 * 1000;
  let hadBrowser = false;
  let abandonTimer: ReturnType<typeof setTimeout> | null = null;
  let onAbandonCallback: (() => void) | undefined;
  let onFinishedCallback: ((payload: { totalRounds: number; totalComments: number }) => void) | undefined;
  let onRevisionErrorCallback: ((message: string) => void) | undefined;
  let onRevisionRecoveredCallback: (() => void) | undefined;

  // Revision watchdog: when /api/accept fires we start a timer. If no terminal
  // event (/api/reload, /api/revision-no-changes, /api/revision-error) arrives
  // within REVISION_TIMEOUT_MS, we assume the resolve flow is wedged (root
  // cause unknown — see docs/retro.md M5 redline-on-itself entry) and surface
  // a `revision-stalled` event so the user can recover. The round is also
  // un-resolved so clicking Revise again is meaningful.
  const REVISION_TIMEOUT_MS = process.env.REDLINE_REVISION_TIMEOUT_MS
    ? parseInt(process.env.REDLINE_REVISION_TIMEOUT_MS, 10)
    : 3 * 60 * 1000;
  let revisionWatchdog: ReturnType<typeof setTimeout> | null = null;
  function clearRevisionWatchdog() {
    if (revisionWatchdog) { clearTimeout(revisionWatchdog); revisionWatchdog = null; }
  }
  function startRevisionWatchdog() {
    clearRevisionWatchdog();
    revisionWatchdog = setTimeout(async () => {
      revisionWatchdog = null;
      const reason = `revision did not complete within ${REVISION_TIMEOUT_MS / 1000}s`;
      console.error(`[redline] ${reason} — un-resolving round and notifying browser.`);
      try {
        await withSidecar(filePath, (sidecar) => {
          const lastResolved = [...sidecar.rounds].reverse().find((r) => r.resolved_at !== null);
          if (!lastResolved) return false as const;
          lastResolved.resolved_at = null;
        });
      } catch (e) {
        console.error("[redline] watchdog: failed to un-resolve round:", e);
      }
      broadcast("revision-stalled", { message: reason });
      // Same recovery semantics as a revision crash — calling agent should see
      // the session as errored if it abandons in this state.
      onRevisionErrorCallback?.(reason);
    }, REVISION_TIMEOUT_MS);
  }

  function checkBrowserPresence() {
    if (browserClients.size > 0) {
      hadBrowser = true;
      if (abandonTimer) { clearTimeout(abandonTimer); abandonTimer = null; }
    } else if (hadBrowser && !abandonTimer) {
      abandonTimer = setTimeout(() => {
        console.log(`\n[redline] No browser connected for ${ABANDON_GRACE_MS / 1000}s — assuming abandoned.`);
        onAbandonCallback?.();
      }, ABANDON_GRACE_MS);
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
    return c.html(pageTemplate(fileName, html, comments, roundResolved, agentRepliedAt, roundNumber, totalRounds, sidecar.context));
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
      // Two comments POSTed within the same millisecond would collide on Date.now() alone.
      // The 4-digit random suffix makes per-ms collision functionally impossible.
      const comment: Comment = {
        id: `c${Date.now()}${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`,
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
      if (role === "agent" && typeof body.requires_revision === "boolean") {
        entry.requires_revision = body.requires_revision;
        if (body.revision_reason?.trim()) entry.revision_reason = body.revision_reason.trim();
      }
      comment.thread.push(entry);
      return { skip: false as const, roundNumber: round.round, comment };
    });
    if (out.skip) return c.json({ ok: false, error: out.error }, out.status as 400 | 404);
    if (role === "human") {
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
      comments: latestRound?.comments ?? [],
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
      roundData.comments,
      true,   // treat as resolved (read-only)
      roundData.agent_replied_at ?? null,
      n,
      sidecar.rounds.length,
      sidecar.context,
      true    // readOnly
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
  // resolved path must stay under the doc directory; the .review subdir is off limits.
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
    try {
      const data = await readFile(requested);
      const ext = path.extname(requested).toLowerCase();
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
    onAbandon(cb: () => void) { onAbandonCallback = cb; },
    onFinished(cb: (payload: { totalRounds: number; totalComments: number }) => void) {
      onFinishedCallback = cb;
    },
    onRevisionError(cb: (message: string) => void) { onRevisionErrorCallback = cb; },
    onRevisionRecovered(cb: () => void) { onRevisionRecoveredCallback = cb; },
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pageTemplate(
  title: string,
  content: string,
  comments: Comment[],
  roundResolved: boolean,
  agentRepliedAt: string | null,
  roundNumber: number,
  totalRounds: number,
  context?: string,
  readOnly = false
): string {
  const commentsJson = JSON.stringify(comments);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Redline</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/styles/github.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/highlight.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #fafaf8;
      --surface: #ffffff;
      --border: #e8e6e1;
      --text: #1a1a1a;
      --text-muted: #6b6b6b;
      --accent: #d97706;
      --accent-light: #fff7ed;
      --highlight: #fff3cd;
      --highlight-active: #ffe8a0;
      --thread-bg: #f7f7f5;
      --agent-bg: #f0f4ff;
      --radius: 6px;
      --shadow: 0 1px 4px rgba(0,0,0,0.08), 0 4px 16px rgba(0,0,0,0.06);
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 16px;
      line-height: 1.7;
    }

    /* ── Layout ── */
    .layout {
      display: flex;
      max-width: 1160px;
      margin: 0 auto;
      padding: 48px 24px;
      gap: 32px;
      align-items: stretch;
    }

    .reader-col {
      flex: 1;
      min-width: 0;
    }

    .sidebar-col {
      width: 300px;
      flex-shrink: 0;
      position: relative;
    }

    /* ── Header ── */
    .doc-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 32px;
    }

    .doc-title {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
      letter-spacing: 0.02em;
      text-transform: uppercase;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .round-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--thread-bg);
      border: 1px solid var(--border);
      color: var(--text-muted);
      text-transform: none;
      letter-spacing: 0;
      white-space: nowrap;
    }
    .round-badge.repeat {
      background: #fff3e0;
      border-color: #ffcc80;
      color: #e65100;
    }
    .round-badge.clickable { cursor: pointer; user-select: none; }
    .round-badge.clickable:hover { filter: brightness(0.95); }

    .round-picker {
      position: absolute;
      top: calc(100% + 8px);
      left: 0;
      background: white;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      z-index: 50;
      min-width: 220px;
      overflow: hidden;
    }
    .round-picker-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 14px;
      font-size: 13px;
      color: var(--text);
      text-decoration: none;
      border-bottom: 1px solid var(--border);
    }
    .round-picker-item:last-child { border-bottom: none; }
    .round-picker-item:hover { background: var(--thread-bg); }
    .round-picker-item.current { font-weight: 600; pointer-events: none; color: var(--text-muted); }
    .round-picker-meta { font-size: 11px; color: var(--text-muted); margin-left: auto; }

    .btn-resolve {
      background: var(--accent);
      color: white;
      border: none;
      padding: 8px 18px;
      border-radius: var(--radius);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .btn-resolve:hover { opacity: 0.85; }
    .btn-resolve:disabled { opacity: 0.4; cursor: default; }

    .btn-accept {
      background: white;
      color: #374151;
      border: 1.5px solid #d1d5db;
      padding: 8px 18px;
      border-radius: var(--radius);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: border-color 0.15s, color 0.15s;
      min-width: 168px;
      text-align: center;
    }
    .btn-accept:hover:not(:disabled) { border-color: #9ca3af; color: #111827; }
    .btn-accept:disabled { opacity: 0.4; cursor: default; }

    .header-actions { display: flex; gap: 8px; }

    /* ── Prose ── */
    .prose {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 48px 56px;
      user-select: text;
    }

    .prose h1, .prose h2, .prose h3, .prose h4 {
      font-weight: 600;
      line-height: 1.3;
      margin: 1.8em 0 0.6em;
      color: var(--text);
    }
    .prose h1 { font-size: 1.9em; margin-top: 0; }
    .prose h2 { font-size: 1.4em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
    .prose h3 { font-size: 1.22em; margin-top: 2em; }
    .prose h4 {
      font-size: 0.85em;
      margin-top: 1.6em;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
    }

    .prose p { margin: 0.9em 0; }
    .prose img { max-width: 100%; height: auto; display: block; margin: 1.2em auto; border-radius: 4px; }
    .prose .broken-img {
      display: block;
      padding: 14px 18px;
      margin: 1.2em auto;
      background: var(--thread-bg);
      border: 1px dashed var(--border);
      border-radius: 4px;
      font-size: 13px;
      color: var(--text-muted);
      text-align: center;
      font-style: italic;
    }
    .prose ul, .prose ol { margin: 0.9em 0; padding-left: 1.6em; }
    .prose li { margin: 0.3em 0; }
    .prose li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1.4em; }
    .prose li > input[type="checkbox"] {
      appearance: none;
      -webkit-appearance: none;
      width: 14px; height: 14px;
      border: 1.5px solid #c5c5bf;
      border-radius: 3px;
      vertical-align: -2px;
      margin-right: 7px;
      cursor: default;
      background: white;
    }
    .prose li > input[type="checkbox"]:checked {
      background-color: var(--accent);
      border-color: var(--accent);
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'><path d='M3 7l3 3 5-6' stroke='white' stroke-width='2' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>");
      background-repeat: no-repeat;
      background-position: center;
    }
    .prose blockquote {
      border-left: 3px solid var(--border);
      margin: 1em 0;
      padding: 0.4em 1em;
      color: var(--text-muted);
    }
    .prose code {
      font-family: "SF Mono", "Fira Code", Menlo, monospace;
      font-size: 0.875em;
      background: #f0efeb;
      padding: 0.15em 0.4em;
      border-radius: 3px;
    }
    .prose pre {
      background: #f6f8fa;
      color: #24292f;
      /* Right padding bumped to give the language label its own visual gutter
         so code content doesn't appear to crowd the right edge. */
      padding: 1em 1.6em 1em 1.2em;
      border-radius: var(--radius);
      border: 1px solid #e1e4e8;
      overflow-x: auto;
      margin: 1.2em 0;
      position: relative;
    }
    .prose pre[data-language]::before {
      content: attr(data-language);
      position: absolute;
      top: 0.4em;
      right: 0.6em;
      font-family: "SF Mono", "Fira Code", Menlo, monospace;
      font-size: 0.7em;
      color: #6e7781;
      text-transform: lowercase;
      letter-spacing: 0.04em;
      pointer-events: none;
    }
    .prose pre code {
      background: none;
      padding: 0;
      font-size: 0.85em;
      color: inherit;
    }
    .prose a { color: #1d4ed8; text-decoration: underline; text-underline-offset: 2px; }
    .prose a:hover { color: #1e40af; }
    .prose hr { border: none; border-top: 1px solid var(--border); margin: 2em 0; }
    .prose table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      margin: 1.2em 0;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      font-size: 14px;
    }
    .prose th, .prose td { padding: 9px 14px; text-align: left; border-bottom: 1px solid var(--border); }
    .prose th { background: #f5f5f3; font-weight: 600; }
    .prose tr:last-child td { border-bottom: none; }
    .prose tbody tr:nth-child(even) td { background: #fafaf9; }
    .prose strong { font-weight: 600; }
    .prose del, .prose s { color: #94a3b8; }

    /* ── Highlights — box-shadow underline avoids any layout shift ── */
    mark.rl-highlight {
      background: rgba(255, 236, 153, 0.45);
      box-shadow: inset 0 -1.5px 0 0 #e8b84b;
      border-radius: 2px;
      cursor: pointer;
      transition: background 0.1s;
    }
    mark.rl-highlight:hover {
      background: rgba(255, 220, 100, 0.65);
    }
    /* Active highlight: amber ring traces the exact span tied to the active card.
       Works for overlapping highlights too — the ring outlines whichever <mark>
       is active, even when nested inside another. */
    mark.rl-highlight.active {
      background: rgba(255, 220, 100, 0.65);
      box-shadow: inset 0 -1.5px 0 0 #e8b84b, 0 0 0 1.5px var(--accent);
      border-radius: 2px;
    }
    mark.rl-highlight.resolved {
      background: rgba(200, 230, 201, 0.45);
      box-shadow: inset 0 -1.5px 0 0 #81c784;
    }
    mark.rl-highlight.rl-pending {
      background: rgba(255, 183, 77, 0.55);
      box-shadow: inset 0 -2px 0 0 #e65100;
      border-radius: 2px;
      cursor: default;
    }
    /* Image-wrapping marks: use a ring instead of underline since images are blocks */
    mark.rl-highlight.rl-img {
      display: block;
      width: fit-content;
      margin: 1.2em auto;
      background: transparent;
      box-shadow: 0 0 0 3px #e8b84b;
      border-radius: 4px;
      line-height: 0;
      padding: 0;
    }
    mark.rl-highlight.rl-img > img { margin: 0; }
    mark.rl-highlight.rl-img.resolved { box-shadow: 0 0 0 3px #81c784; }
    mark.rl-highlight.rl-img.rl-pending { box-shadow: 0 0 0 3px #e65100; }
    mark.rl-highlight.rl-img:hover, mark.rl-highlight.rl-img.active {
      box-shadow: 0 0 0 3px #c0392b;
    }
    /* Hover affordance on images so it's discoverable that you can comment */
    .prose img { cursor: pointer; transition: box-shadow 0.15s; }
    .prose img:hover { box-shadow: 0 0 0 2px rgba(217,119,6,0.4); border-radius: 4px; }


    /* ── Sidebar ── */
    .sidebar-empty {
      font-size: 13px;
      color: var(--text-muted);
      text-align: center;
      padding: 24px 0;
    }

    .comment-card {
      position: absolute;
      width: 100%;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      transition: border-color 0.15s, box-shadow 0.15s;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    }
    .comment-card.active { border-color: var(--accent); box-shadow: 0 2px 8px rgba(217,119,6,0.12); }
    .comment-card.resolved { opacity: 0.55; }
    .comment-card.resolved .comment-body { display: none; }
    .comment-card.resolved.expanded .comment-body { display: block; }
    .comment-card.resolved .comment-quote { cursor: pointer; }
    .comment-card.resolved .comment-quote::after {
      content: '▸';
      float: right;
      margin-left: 8px;
      opacity: 0.5;
      font-style: normal;
    }
    .comment-card.resolved.expanded .comment-quote::after { content: '▾'; }

    .comment-quote {
      padding: 10px 14px;
      font-size: 12.5px;
      color: var(--text-muted);
      background: var(--thread-bg);
      border-bottom: 1px solid var(--border);
      font-style: italic;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .comment-card.resolved .comment-quote { border-bottom: none; }
    .comment-card.resolved.expanded .comment-quote { border-bottom: 1px solid var(--border); }

    /* Last agent reply shown on collapsed resolved cards */
    .card-commitment {
      padding: 7px 14px 9px;
      font-size: 12px;
      color: #3b5bdb;
      line-height: 1.5;
      border-top: 1px solid var(--border);
    }
    .comment-card.resolved.expanded .card-commitment { display: none; }

    .comment-thread { padding: 10px 14px; }

    /* ── Comment navigator ── */
    #comment-nav {
      position: sticky;
      top: 0;
      z-index: 5;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 8px 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--text-muted);
    }
    #comment-nav .nav-count {
      flex: 1;
      font-weight: 500;
    }
    #comment-nav button {
      background: none;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 3px 9px;
      font-size: 12px;
      cursor: pointer;
      color: var(--text);
      line-height: 1.4;
    }
    #comment-nav button:hover { background: var(--thread-bg); }
    #comment-nav button:disabled { opacity: 0.3; cursor: default; }

    /* Soften the swap when the nav hides and the status banner appears
       (and vice versa) — display can't transition, so just fade the
       *appearance* with a brief animation. */
    #comment-nav, #sidebar-status-banner { animation: rl-fade-in 0.18s ease-out; }
    @keyframes rl-fade-in { from { opacity: 0; } to { opacity: 1; } }

    .thread-entry {
      margin-bottom: 10px;
    }
    .thread-entry:last-child { margin-bottom: 0; }

    .thread-role {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 3px;
    }
    .thread-role.human { color: var(--accent); }
    .thread-role.agent { color: #3b5bdb; }

    .thread-message {
      font-size: 13.5px;
      line-height: 1.5;
      color: var(--text);
    }

    /* ── Verdict footer on agent replies ── */
    .verdict {
      margin-top: 6px;
      font-size: 12px;
      line-height: 1.45;
      display: flex;
      gap: 6px;
      align-items: baseline;
    }
    .verdict-icon {
      font-size: 11px;
      flex-shrink: 0;
      line-height: 1.5;
    }
    .verdict.revise { color: #92400e; }

    /* Warm-tinted resolve button when the latest verdict implies an edit */
    .btn-resolve-comment.revise {
      border-color: #f59e0b;
      color: #92400e;
    }
    .btn-resolve-comment.revise:hover {
      background: #fffbeb;
      border-color: #d97706;
    }

    /* Per-card verdict badge on resolved cards (next to ✓ Resolved) */
    .verdict-badge {
      display: inline-flex;
      align-items: center;
      margin-left: 6px;
      padding: 1px 6px;
      font-size: 10.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-radius: 3px;
      font-style: normal;
    }
    .verdict-badge.revise { background: #fef3c7; color: #92400e; }
    .verdict-badge.accept { background: #e5e7eb; color: var(--text-muted); }

    /* Round-level secondary action (under the primary banner button) */
    .round-secondary {
      margin-top: 8px;
      font-size: 12.5px;
      color: var(--text-muted);
      text-align: center;
    }
    .round-secondary button {
      background: none;
      border: none;
      padding: 0;
      color: var(--accent);
      cursor: pointer;
      font: inherit;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .round-secondary button:hover { color: #c2410c; }

    .thinking-dots { display: flex; gap: 4px; align-items: center; padding: 2px 0; }
    .thinking-dots span {
      width: 6px; height: 6px; border-radius: 50%;
      background: #3b5bdb; opacity: 0.4;
      animation: thinking-bounce 1.2s infinite ease-in-out;
    }
    .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
    .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes thinking-bounce {
      0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
      40% { transform: translateY(-4px); opacity: 1; }
    }

    .comment-actions {
      display: flex;
      gap: 8px;
      padding: 8px 14px;
      border-top: 1px solid var(--border);
    }

    .btn-reply {
      font-size: 12px;
      padding: 4px 10px;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      background: white;
      cursor: pointer;
      color: var(--text-muted);
      transition: all 0.1s;
    }
    .btn-reply:hover { border-color: var(--text-muted); color: var(--text); }

    .btn-reopen {
      font-size: 12px;
      padding: 4px 10px;
      border-radius: var(--radius);
      border: 1px solid #3b5bdb;
      background: white;
      cursor: pointer;
      color: #3b5bdb;
      transition: all 0.1s;
    }
    .btn-reopen:hover { background: #eef2ff; }

    .btn-resolve-comment {
      font-size: 12px;
      padding: 4px 10px;
      border-radius: var(--radius);
      border: 1px solid transparent;
      background: #e8f5e9;
      color: #2e7d32;
      cursor: pointer;
      transition: all 0.1s;
    }
    .btn-resolve-comment:hover { background: #c8e6c9; }

    /* ── Reply input ── */
    .reply-form {
      display: none;
      padding: 8px 14px;
      border-top: 1px solid var(--border);
      background: var(--thread-bg);
    }
    .reply-form.open { display: block; }

    .reply-input {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 7px 10px;
      font-size: 13px;
      font-family: inherit;
      resize: vertical;
      min-height: 64px;
      background: white;
    }
    .reply-input:focus { outline: none; border-color: var(--accent); }

    .reply-submit {
      margin-top: 6px;
      background: var(--accent);
      color: white;
      border: none;
      padding: 5px 12px;
      border-radius: var(--radius);
      font-size: 12px;
      cursor: pointer;
    }
    .reply-submit:hover { opacity: 0.85; }

    /* ── New comment form in sidebar ── */
    .new-comment-form {
      position: absolute;
      width: 100%;
      background: var(--surface);
      border: 1px solid var(--accent);
      border-radius: var(--radius);
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(217,119,6,0.12);
      z-index: 10;
    }

    .new-comment-quote {
      padding: 10px 14px;
      font-size: 12.5px;
      color: var(--text-muted);
      background: var(--accent-light);
      border-bottom: 1px solid var(--border);
      font-style: italic;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .new-comment-body {
      padding: 10px 14px;
    }

    .new-comment-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
    }

    .btn-cancel-inline {
      background: none;
      border: 1px solid var(--border);
      padding: 5px 12px;
      border-radius: var(--radius);
      font-size: 12px;
      cursor: pointer;
      color: var(--text-muted);
    }

    /* ── kbd shortcut label ── */
    .reply-submit kbd {
      display: inline-block;
      font-size: 10px;
      font-family: inherit;
      opacity: 0.7;
      margin-left: 5px;
      font-style: normal;
    }

    /* ── Resolved badge ── */
    .resolved-badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      color: #2e7d32;
      background: #e8f5e9;
      padding: 2px 7px;
      border-radius: 10px;
      float: right;
      margin-left: 8px;
    }

    /* ── Review submitted sidebar banner ── */
    #sidebar-status-banner {
      display: none;
      padding: 10px 14px;
      margin-bottom: 14px;
      background: #e8f5e9;
      border-bottom: 1px solid #a5d6a7;
      color: #2e7d32;
      font-size: 13px;
      font-weight: 500;
      align-items: center;
      gap: 8px;
    }
    #sidebar-status-banner.revising {
      background: #fff3e0;
      border-bottom-color: #ffb74d;
      color: #e65100;
      flex-direction: column;
      align-items: flex-start;
      gap: 0;
    }
    #sidebar-status-banner.error {
      background: #fdecea;
      border-bottom-color: #f5c2c0;
      color: #a01818;
    }
    .revising-header { display: flex; align-items: center; gap: 8px; }
    #revision-stream {
      display: none;
      margin-top: 8px;
      width: 100%;
      max-height: 220px;
      overflow-y: auto;
      background: rgba(0,0,0,0.05);
      border-radius: 4px;
      padding: 7px 9px;
      font-family: 'Menlo','Monaco',monospace;
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.5;
      box-sizing: border-box;
    }
    #revision-stream .rs-thinking { color: #9a7b3f; font-style: italic; opacity: 0.75; }
    #revision-stream .rs-text { color: #5a3a00; }
    .revising-spinner {
      display: inline-block;
      width: 12px; height: 12px;
      border: 2px solid #ffb74d;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spinner-rotate 0.8s linear infinite;
      flex-shrink: 0;
    }
    @keyframes spinner-rotate { to { transform: rotate(360deg); } }
    .revising-dots span {
      animation: dot-blink 1.4s infinite both;
      opacity: 0;
    }
    .revising-dots span:nth-child(1) { animation-delay: 0s; }
    .revising-dots span:nth-child(2) { animation-delay: 0.2s; }
    .revising-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes dot-blink {
      0%, 60%, 100% { opacity: 0; }
      30% { opacity: 1; }
    }

    /* ── Done banner ── */
    #done-banner { display: none; }

    /* ── Diff overlay ── */
    #diff-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.45);
      z-index: 100;
      align-items: flex-start;
      justify-content: center;
      padding: 40px 24px;
      overflow-y: auto;
    }
    #diff-overlay.open { display: flex; }
    #diff-panel {
      background: white;
      border-radius: 8px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.18);
      width: 100%;
      max-width: 820px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    #diff-panel-header {
      display: flex;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      gap: 12px;
    }
    #diff-panel-header h2 {
      flex: 1;
      font-size: 15px;
      font-weight: 600;
      margin: 0;
    }
    #diff-panel-body {
      overflow-y: auto;
      max-height: 65vh;
      padding: 8px 40px 40px;
    }
    .diff-prose { max-width: 660px; margin: 0 auto; }
    .diff-prose h1 { font-size: 2em; font-weight: 700; margin: 1.5em 0 0.5em; }
    .diff-prose h2 { font-size: 1.4em; font-weight: 700; margin: 1.4em 0 0.4em; padding-bottom: 0.25em; border-bottom: 1px solid var(--border); }
    .diff-prose h3 { font-size: 1.1em; font-weight: 600; margin: 1.2em 0 0.3em; }
    .diff-prose p { margin: 0.8em 0; line-height: 1.7; }
    .diff-prose pre { background: #f6f8fa; border-radius: 6px; padding: 14px 16px; overflow-x: auto; font-size: 13px; }
    .diff-prose code { font-family: 'Menlo','Monaco',monospace; font-size: 0.875em; background: #f0f0ed; padding: 1px 4px; border-radius: 3px; }
    .diff-prose pre code { background: none; padding: 0; }
    .diff-prose a { color: #1d4ed8; text-decoration: underline; text-underline-offset: 2px; }
    .diff-prose a:hover { color: #1e40af; }
    .diff-prose ul, .diff-prose ol { padding-left: 1.5em; margin: 0.8em 0; }
    .diff-prose li { margin: 0.3em 0; line-height: 1.7; }
    .diff-block { border-radius: 4px; margin: 2px -12px; padding: 2px 12px; }
    .diff-block-add { background: #e6ffed; border-left: 3px solid #28a745; }
    .diff-block-del { background: #ffeef0; border-left: 3px solid #d73a49; opacity: 0.8; }
    .diff-block-mod { background: #fffbe6; border-left: 3px solid #f0ad00; }
    ins.diff-word-add { background: #acf2bd; text-decoration: none; border-radius: 2px; padding: 0 1px; }
    del.diff-word-del { background: #fdb8c0; border-radius: 2px; padding: 0 1px; }
    .diff-no-changes { padding: 24px 0; color: var(--text-muted); }
    .btn-diff-compare {
      font-size: 12px;
      padding: 4px 10px;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      background: white;
      cursor: pointer;
      color: var(--text-muted);
      transition: all 0.1s;
    }
    .btn-diff-compare:hover { color: var(--text); border-color: #aaa; }
    .btn-diff-accept {
      background: #2e7d32;
      color: white;
      border: none;
      padding: 8px 18px;
      border-radius: var(--radius);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }
    .btn-diff-accept:hover { opacity: 0.85; }
    .btn-diff-feedback {
      background: none;
      border: 1px solid var(--border);
      padding: 8px 18px;
      border-radius: var(--radius);
      font-size: 14px;
      cursor: pointer;
      color: var(--text);
    }
    .btn-diff-feedback:hover { background: var(--thread-bg); }
    .btn-diff-close {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-muted);
      font-size: 16px;
      padding: 4px 8px;
      border-radius: 4px;
      line-height: 1;
    }
    .btn-diff-close:hover { background: var(--thread-bg); color: var(--text); }

    /* ── Empty-rail hint (cold-open only) ── */
    .empty-rail-hint {
      padding: 14px 16px;
      font-size: 13px;
      color: var(--text-muted);
      font-style: italic;
      text-align: center;
      opacity: 0.75;
    }

    /* ── Revision banner ── */
    .revision-banner {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      border-radius: var(--radius);
      margin-bottom: 14px;
      font-size: 13.5px;
      color: #1e40af;
    }
    .revision-banner-text { flex: 1; }
    .revision-banner-link {
      background: none;
      border: none;
      cursor: pointer;
      color: #1d4ed8;
      font-size: 13.5px;
      font-weight: 500;
      padding: 0;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .revision-banner-link:hover { color: #1e40af; }
    .revision-banner-dismiss {
      background: none;
      border: none;
      cursor: pointer;
      color: #60a5fa;
      font-size: 13px;
      padding: 1px 4px;
      border-radius: 3px;
      line-height: 1;
      opacity: 0.7;
      flex-shrink: 0;
    }
    .revision-banner-dismiss:hover { opacity: 1; background: rgba(96,165,250,0.15); }

    /* ── Context banner ── */
    .context-banner {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 9px 14px;
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-radius: var(--radius);
      margin-bottom: 14px;
      font-size: 13.5px;
      color: #78350f;
      line-height: 1.5;
    }
    .context-label {
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-size: 10.5px;
      color: #b45309;
      white-space: nowrap;
      padding-top: 2px;
      flex-shrink: 0;
    }
    .context-text { flex: 1; }
    .context-dismiss {
      background: none;
      border: none;
      cursor: pointer;
      color: #b45309;
      font-size: 13px;
      padding: 1px 4px;
      border-radius: 3px;
      line-height: 1;
      opacity: 0.6;
      flex-shrink: 0;
    }
    .context-dismiss:hover { opacity: 1; background: rgba(180,83,9,0.1); }
  </style>
</head>
<body>
  <div class="layout">
    <div class="reader-col">
      <div class="doc-header">
        <span class="doc-title">
          ${escapeHtml(title)}
          <span style="position:relative">
            <span class="round-badge${totalRounds > 1 ? ' repeat' : ''}${totalRounds > 1 ? ' clickable' : ''}" id="round-badge">Round ${roundNumber} of ${totalRounds}</span>
            ${totalRounds > 1 ? `<div class="round-picker" id="round-picker" style="display:none">${
              Array.from({length: totalRounds}, (_, i) => i + 1).map(n => {
                const isCurrent = n === roundNumber;
                const href = n === totalRounds ? '/' : `/round/${n}`;
                const label = n === totalRounds ? 'Round ' + n + ' — current' : 'Round ' + n;
                return `<a class="round-picker-item${isCurrent ? ' current' : ''}" href="${href}">${label}</a>`;
              }).join('')
            }</div>` : ''}
          </span>
        </span>
        <div class="header-actions">
          ${readOnly
            ? `<span style="font-size:13px;color:var(--text-muted);font-style:italic">Read-only — <a href="/" style="color:var(--accent)">back to current</a></span>`
            : `<button class="btn-accept" id="btn-accept" disabled>Revise document</button>
               ${totalRounds > 1 ? `<button class="btn-diff-compare" id="btn-compare">Compare with previous</button>` : ''}`
          }
        </div>
      </div>
      ${context ? `<div class="context-banner" id="context-banner">
        <span class="context-label">Context</span>
        <span class="context-text">${escapeHtml(context)}</span>
        <button class="context-dismiss" onclick="dismissContextBanner()" aria-label="Dismiss">✕</button>
      </div>` : ''}
      <article class="prose" id="prose">
        ${content}
      </article>
    </div>

    <div class="sidebar-col">
      <div id="sidebar-status-banner"></div>
      <div id="comment-nav" style="display:none">
        <span class="nav-count" id="nav-count"></span>
        <button id="nav-prev">↑ Prev</button>
        <button id="nav-next">Next ↓</button>
      </div>
    </div>
  </div>


  <div id="done-banner"></div>
  <div id="diff-overlay">
    <div id="diff-panel">
      <div id="diff-panel-header">
        <h2>Review changes</h2>
        <button class="btn-diff-feedback" id="diff-btn-feedback">Give more feedback</button>
        <button class="btn-diff-accept" id="diff-btn-accept">Looks good — close session</button>
        <button class="btn-diff-close" id="diff-btn-close" aria-label="Close">✕</button>
      </div>
      <div id="diff-panel-body"></div>
    </div>
  </div>
  <div id="error-banner" style="display:none;position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#b71c1c;color:white;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:500;box-shadow:0 1px 4px rgba(0,0,0,0.08);z-index:999;white-space:nowrap;"></div>

  <script>
    window.__REDLINE__ = {
      comments: ${commentsJson},
      roundResolved: ${roundResolved},
      totalRounds: ${totalRounds},
      contextTitle: ${JSON.stringify(title)},
    };
  </script>
  <script src="/client.js" defer></script>
</body>
</html>`;
}
