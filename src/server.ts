import { Hono } from "hono";
import { readFile } from "fs/promises";
import path from "path";
import { renderMarkdown } from "./render";
import {
  loadSidecar,
  saveSidecar,
  getOrCreateActiveRound,
  activeRound,
  type Comment,
} from "./sidecar";

export function createServer(filePath: string, opts: { context?: string } = {}) {
  const app = new Hono();
  const fileName = path.basename(filePath);

  // On startup, ensure there is always an open round to receive comments
  (async () => {
    const sidecar = await loadSidecar(filePath);
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
    if (changed) await saveSidecar(filePath, sidecar);
  })();

  // ── SSE broadcast ────────────────────────────────────────────────────
  const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const browserClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();

  // Abandonment detection: if no browser is connected for ABANDON_GRACE_MS after
  // the first one ever connected, fire onAbandonCallback so the CLI can exit.
  const ABANDON_GRACE_MS = process.env.REDLINE_ABANDON_MS
    ? parseInt(process.env.REDLINE_ABANDON_MS, 10)
    : 2 * 60 * 1000; // default 2 minutes
  let hadBrowser = false;
  let abandonTimer: ReturnType<typeof setTimeout> | null = null;
  let onAbandonCallback: (() => void) | undefined;
  let onFinishedCallback: ((payload: { totalRounds: number; totalComments: number }) => void) | undefined;

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

    const sidecar = await loadSidecar(filePath);
    const round = getOrCreateActiveRound(sidecar);

    const comment: Comment = {
      id: `c${Date.now()}`,
      quote: body.quote,
      context_before: body.context_before,
      context_after: body.context_after,
      thread: [
        { role: "human", message: body.message, at: new Date().toISOString() },
      ],
      resolved: false,
    };

    round.comments.push(comment);
    await saveSidecar(filePath, sidecar);
    broadcast("comment-added", { round: round.round, commentId: comment.id });

    return c.json({ ok: true, comment });
  });

  // Mark a comment resolved
  app.post("/api/comment/:id/resolve", async (c) => {
    const id = c.req.param("id");

    const sidecar = await loadSidecar(filePath);
    const round = activeRound(sidecar);
    if (!round) return c.json({ ok: false, error: "No active round" }, 400);

    const comment = round.comments.find((cm) => cm.id === id);
    if (!comment) return c.json({ ok: false, error: "Comment not found" }, 404);

    comment.resolved = true;
    await saveSidecar(filePath, sidecar);

    const allResolved = round.comments.length > 0 && round.comments.every((cm) => cm.resolved);
    broadcast("comment-resolved", { round: round.round, commentId: id, allResolved });

    return c.json({ ok: true, allResolved });
  });

  // Reopen a resolved comment
  app.post("/api/comment/:id/reopen", async (c) => {
    const id = c.req.param("id");
    const sidecar = await loadSidecar(filePath);
    const latestRound = sidecar.rounds[sidecar.rounds.length - 1] ?? null;
    if (!latestRound) return c.json({ ok: false, error: "No round found" }, 400);
    const comment = latestRound.comments.find((cm) => cm.id === id);
    if (!comment) return c.json({ ok: false, error: "Comment not found" }, 404);
    comment.resolved = false;
    await saveSidecar(filePath, sidecar);
    // Broadcast so other browser tabs and the agent see the reopen.
    const allResolved = latestRound.comments.length > 0 && latestRound.comments.every((cm) => cm.resolved);
    broadcast("comment-resolved", { round: latestRound.round, commentId: id, allResolved });
    return c.json({ ok: true, comment });
  });

  // Submit for agent review — signals the agent to respond to comments
  app.post("/api/submit", async (c) => {
    const sidecar = await loadSidecar(filePath);
    const round = activeRound(sidecar);
    if (!round) return c.json({ ok: false, error: "No active round" }, 400);
    if (round.comments.length === 0) return c.json({ ok: false, error: "No comments to submit" }, 400);

    round.submitted_at = new Date().toISOString();
    round.agent_replied_at = null; // clear so agent knows to respond again
    await saveSidecar(filePath, sidecar);
    broadcast("submitted", { round: round.round, comments: round.comments.length });
    return c.json({ ok: true });
  });

  // Accept & revise — human is done discussing; agent should now revise the document
  app.post("/api/accept", async (c) => {
    const sidecar = await loadSidecar(filePath);
    const round = activeRound(sidecar);
    if (!round) return c.json({ ok: false, error: "No active round" }, 400);

    round.resolved_at = new Date().toISOString();
    await saveSidecar(filePath, sidecar);
    broadcast("accepted", { round: round.round });
    return c.json({ ok: true });
  });

  // Finish a round with no comments — no revision needed, just close out
  app.post("/api/finish", async (c) => {
    const sidecar = await loadSidecar(filePath);
    const round = activeRound(sidecar);
    if (!round) return c.json({ ok: false, error: "No active round" }, 400);
    round.resolved_at = new Date().toISOString();
    await saveSidecar(filePath, sidecar);
    broadcast("finished", { round: round.round });

    const totalRounds = sidecar.rounds.filter((r: any) => r.resolved_at).length;
    const totalComments = sidecar.rounds.reduce((n: number, r: any) => n + (r.comments?.length ?? 0), 0);
    // Let the CLI handle the summary printout, result-file writing, and process exit.
    setTimeout(() => onFinishedCallback?.({ totalRounds, totalComments }), 500);
    return c.json({ ok: true });
  });

  // Called by redline resolve after writing the revised document
  app.post("/api/reload", (c) => {
    broadcast("reload", {});
    return c.json({ ok: true });
  });

  // Called by redline resolve when the model returned no changes
  app.post("/api/revision-no-changes", (c) => {
    broadcast("revision-no-changes", {});
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
    const { message } = await c.req.json();
    const sidecar = await loadSidecar(filePath);
    const lastResolved = [...sidecar.rounds].reverse().find((r) => r.resolved_at !== null);
    if (lastResolved) {
      lastResolved.resolved_at = null;
      await saveSidecar(filePath, sidecar);
    }
    broadcast("revision-error", { message });
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
    const body = await c.req.json<{ message: string; role?: string; name?: string }>();
    if (!body.message?.trim()) return c.json({ ok: false, error: "message is required" }, 400);
    const role = (body.role === "human" ? "human" : "agent") as "human" | "agent";
    const name = body.name?.trim() || undefined;

    const sidecar = await loadSidecar(filePath);
    const round = activeRound(sidecar);
    if (!round) return c.json({ ok: false, error: "No active round" }, 400);
    const comment = round.comments.find((c) => c.id === id);
    if (!comment) return c.json({ ok: false, error: "Comment not found" }, 404);

    const entry: { role: "human" | "agent"; name?: string; message: string; at: string } = { role, message: body.message.trim(), at: new Date().toISOString() };
    if (name) entry.name = name;
    comment.thread.push(entry);
    await saveSidecar(filePath, sidecar);

    if (role === "human") {
      broadcast("comment-reply", { round: round.round, commentId: id });
    }

    return c.json({ ok: true, comment });
  });

  // Agent signals it has finished replying to all comments
  app.post("/api/agent-replied", async (c) => {
    const sidecar = await loadSidecar(filePath);
    const round = activeRound(sidecar);
    if (!round) return c.json({ ok: false, error: "No active round" }, 400);

    round.agent_replied_at = new Date().toISOString();
    await saveSidecar(filePath, sidecar);
    broadcast("agent-replied", { round: round.round });
    return c.json({ ok: true });
  });

  // Keep /api/resolve as an alias for backward compat
  app.post("/api/resolve", async (c) => {
    const sidecar = await loadSidecar(filePath);
    const round = activeRound(sidecar);
    if (!round) return c.json({ ok: false, error: "No active round" }, 400);
    if (round.comments.length === 0) return c.json({ ok: false, error: "No comments to submit" }, 400);
    round.submitted_at = new Date().toISOString();
    await saveSidecar(filePath, sidecar);
    return c.json({ ok: true });
  });

  // Live comments for the active round (used by client soft-refresh)
  app.get("/api/comments", async (c) => {
    const sidecar = await loadSidecar(filePath);
    const latestRound = sidecar.rounds[sidecar.rounds.length - 1] ?? null;
    return c.json({
      comments: latestRound?.comments ?? [],
      roundResolved: latestRound?.resolved_at != null,
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
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function splitBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) inFence = !inFence;
    if (!inFence && line.trim() === '') {
      if (current.length > 0) { blocks.push(current.join('\n')); current = []; }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks.filter(b => b.trim().length > 0);
}

function lcsOps<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): Array<{type: 'equal'|'insert'|'delete', aVal?: T, bVal?: T}> {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({length: m+1}, () => new Array(n+1).fill(0));
  for (let i = m-1; i >= 0; i--)
    for (let j = n-1; j >= 0; j--)
      dp[i][j] = eq(a[i], b[j]) ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
  const ops: Array<{type: 'equal'|'insert'|'delete', aVal?: T, bVal?: T}> = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && eq(a[i], b[j])) { ops.push({type: 'equal', aVal: a[i], bVal: b[j]}); i++; j++; }
    else if (j < n && (i >= m || dp[i][j+1] >= dp[i+1][j])) { ops.push({type: 'insert', bVal: b[j]}); j++; }
    else { ops.push({type: 'delete', aVal: a[i]}); i++; }
  }
  return ops;
}

function wordDiffMarkdown(oldStr: string, newStr: string): string {
  const tokens = (s: string) => s.match(/\S+|\s+/g) ?? [];
  const ops = lcsOps(tokens(oldStr), tokens(newStr), (a, b) => a === b);
  return ops.map(op => {
    if (op.type === 'equal') return op.aVal!;
    if (op.type === 'insert') return `<ins class="diff-word-add">${escapeHtml(op.bVal!)}</ins>`;
    return `<del class="diff-word-del">${escapeHtml(op.aVal!)}</del>`;
  }).join('');
}

function renderDocDiff(oldText: string, newText: string): string {
  const oldBlocks = splitBlocks(oldText);
  const newBlocks = splitBlocks(newText);
  const raw = lcsOps(oldBlocks, newBlocks, (a, b) => a === b);

  // Merge adjacent delete+insert into a single modify op
  type MergedOp = {type: 'equal'|'insert'|'delete'|'modify', a?: string, b?: string};
  const ops: MergedOp[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].type === 'delete' && i+1 < raw.length && raw[i+1].type === 'insert') {
      ops.push({type: 'modify', a: raw[i].aVal, b: raw[i+1].bVal}); i++;
    } else {
      ops.push({type: raw[i].type as any, a: raw[i].aVal, b: raw[i].bVal});
    }
  }

  if (ops.every(op => op.type === 'equal')) {
    return '<div class="diff-no-changes">No changes between versions.</div>';
  }

  let html = '<div class="diff-prose">';
  for (const op of ops) {
    if (op.type === 'equal') {
      html += renderMarkdown(op.b!);
    } else if (op.type === 'insert') {
      html += `<div class="diff-block diff-block-add">${renderMarkdown(op.b!)}</div>`;
    } else if (op.type === 'delete') {
      html += `<div class="diff-block diff-block-del">${renderMarkdown(op.a!)}</div>`;
    } else {
      const isCode = op.a!.trimStart().startsWith('```') || op.b!.trimStart().startsWith('```');
      if (isCode) {
        html += `<div class="diff-block diff-block-del">${renderMarkdown(op.a!)}</div>`;
        html += `<div class="diff-block diff-block-add">${renderMarkdown(op.b!)}</div>`;
      } else {
        html += `<div class="diff-block diff-block-mod">${renderMarkdown(wordDiffMarkdown(op.a!, op.b!))}</div>`;
      }
    }
  }
  html += '</div>';
  return html;
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
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #fafaf8;
      --surface: #ffffff;
      --border: #e8e6e1;
      --text: #1a1a1a;
      --text-muted: #6b6b6b;
      --accent: #c0392b;
      --accent-light: #fdf2f2;
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
      padding: 1em 1.2em;
      border-radius: var(--radius);
      border: 1px solid #e1e4e8;
      overflow-x: auto;
      margin: 1.2em 0;
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
    mark.rl-highlight:hover, mark.rl-highlight.active {
      background: rgba(255, 220, 100, 0.65);
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
    .prose img:hover { box-shadow: 0 0 0 2px rgba(192,57,43,0.4); border-radius: 4px; }


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
    .comment-card.active { border-color: var(--accent); box-shadow: 0 2px 8px rgba(192,57,43,0.12); }
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
      box-shadow: 0 2px 8px rgba(192,57,43,0.12);
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
    // ── State ────────────────────────────────────────────────────────
    let comments = ${commentsJson};
    let roundResolved = ${roundResolved};
    const totalRounds = ${totalRounds};
    const thinkingCommentIds = new Set();
    let pendingSelection = null;
    let selectionTimer = null;

    // ── Selection → form (debounced so double/triple-click completes first) ──
    document.addEventListener('mouseup', () => {
      if (selectionTimer) { clearTimeout(selectionTimer); selectionTimer = null; }

      selectionTimer = setTimeout(() => {
        selectionTimer = null;
        if (document.getElementById('new-comment-form')) return;

        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const text = sel.toString().trim();
        // Require at least 2 characters to avoid accidental single-letter comments
        // from stray click-drags.
        if (!text || text.length < 2) return;

        const prose = document.getElementById('prose');
        if (!prose.contains(sel.anchorNode)) return;

        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        pendingSelection = captureSelection(sel, text);
        pendingSelection._rectTop = rect.top;
        pendingSelection._range = range.cloneRange();

        const sidebarRect = document.querySelector('.sidebar-col').getBoundingClientRect();
        showNewCommentForm(pendingSelection, rect.top - sidebarRect.top);
      }, 250);
    });

    // Image click → open a new-comment form anchored to the image.
    // The selection-based path doesn't fire on <img> (no text), so we handle it explicitly.
    document.addEventListener('click', (e) => {
      if (e.target.tagName !== 'IMG') return;
      const prose = document.getElementById('prose');
      if (!prose.contains(e.target)) return;
      if (document.getElementById('new-comment-form')) return;
      e.preventDefault();
      const img = e.target;
      const alt = img.alt || '';
      const quote = '[image: ' + alt + ']';

      const rect = img.getBoundingClientRect();
      const sidebarRect = document.querySelector('.sidebar-col').getBoundingClientRect();
      pendingSelection = { quote, context_before: '', context_after: '' };
      pendingSelection._rectTop = rect.top;
      pendingSelection._img = img;
      showNewCommentForm(pendingSelection, rect.top - sidebarRect.top);
    }, true);

    // Cancel pending open and close any open form when clicking outside it
    document.addEventListener('mousedown', (e) => {
      if (selectionTimer) { clearTimeout(selectionTimer); selectionTimer = null; }
      const form = document.getElementById('new-comment-form');
      if (form && !form.contains(e.target)) {
        dismissNewCommentForm();
      }
    });

    function showNewCommentForm(selection, formTop) {
      document.getElementById('new-comment-form')?.remove();
      removePendingHighlight();
      window.getSelection()?.removeAllRanges();

      if (selection._range) applyPendingHighlight(selection._range);
      else if (selection._img) applyPendingImgHighlight(selection._img);

      const form = document.createElement('div');
      form.id = 'new-comment-form';
      form.className = 'new-comment-form';
      form.style.top = Math.max(0, formTop) + 'px';

      const body = document.createElement('div');
      body.className = 'new-comment-body';

      const textarea = document.createElement('textarea');
      textarea.className = 'reply-input';
      textarea.placeholder = 'Leave a comment…';
      body.appendChild(textarea);

      const actions = document.createElement('div');
      actions.className = 'new-comment-actions';

      const cancel = document.createElement('button');
      cancel.className = 'btn-cancel-inline';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        dismissNewCommentForm();
      });

      const save = document.createElement('button');
      save.className = 'reply-submit';
      save.innerHTML = 'Save <kbd>⌘↵</kbd>';
      save.addEventListener('click', () => saveComment(form, textarea, selection));

      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveComment(form, textarea, selection);
        if (e.key === 'Escape') {
          dismissNewCommentForm();
        }
      });

      actions.appendChild(cancel);
      actions.appendChild(save);
      body.appendChild(actions);
      form.appendChild(body);

      document.querySelector('.sidebar-col').appendChild(form);
      textarea.focus();
      positionCards();
    }

    function dismissNewCommentForm() {
      const form = document.getElementById('new-comment-form');
      if (form) form.remove();
      removePendingHighlight();
      pendingSelection = null;
      positionCards();
    }

    function applyPendingHighlight(range) {
      const ancestor = range.commonAncestorContainer;
      const root = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentNode : ancestor;

      // Collect intersecting text nodes before mutating the DOM
      const textNodes = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        if (range.intersectsNode(node)) textNodes.push(node);
      }

      for (const tn of textNodes) {
        const start = (tn === range.startContainer) ? range.startOffset : 0;
        const end = (tn === range.endContainer) ? range.endOffset : tn.nodeValue.length;
        if (start >= end) continue;

        const mark = document.createElement('mark');
        mark.className = 'rl-highlight rl-pending';
        mark.dataset.commentId = 'pending';

        const mid = tn.splitText(start);
        mid.splitText(end - start);
        mid.parentNode.insertBefore(mark, mid);
        mark.appendChild(mid);
      }
    }

    function applyPendingImgHighlight(img) {
      const mark = document.createElement('mark');
      mark.className = 'rl-highlight rl-pending rl-img';
      mark.dataset.commentId = 'pending';
      img.parentNode.insertBefore(mark, img);
      mark.appendChild(img);
    }

    function removePendingHighlight() {
      const prose = document.getElementById('prose');
      prose.querySelectorAll('[data-comment-id="pending"]').forEach(m => {
        const parent = m.parentNode;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        parent.removeChild(m);
      });
      prose.normalize();
    }

    function captureSelection(sel, text) {
      const prose = document.getElementById('prose');
      const range = sel.getRangeAt(0);

      // Build flat text from text nodes so we can locate the exact selection position
      const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
      const segments = [];
      let flat = '';
      let node;
      while (node = walker.nextNode()) {
        segments.push({ node, start: flat.length });
        flat += node.nodeValue;
      }

      // Find where the selection actually starts in the flat text
      let quoteStart = -1;
      for (const seg of segments) {
        if (seg.node === range.startContainer) {
          quoteStart = seg.start + range.startOffset;
          break;
        }
      }

      if (quoteStart === -1) {
        return { quote: text, context_before: '', context_after: '' };
      }

      return {
        quote: text,
        context_before: flat.slice(Math.max(0, quoteStart - 32), quoteStart),
        context_after: flat.slice(quoteStart + text.length, quoteStart + text.length + 32),
      };
    }

    async function saveComment(form, textarea, selection) {
      const message = textarea.value.trim();
      if (!message) {
        textarea.focus();
        textarea.style.borderColor = 'var(--accent)';
        textarea.placeholder = 'Type a comment first…';
        return;
      }

      try {
        const res = await fetch('/api/comment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...selection, message }),
        });
        const data = await res.json();
        if (data.ok) {
          form.remove();
          removePendingHighlight();
          // Avoid duplicating if SSE comment-added already pushed via softRefresh
          if (!comments.some(c => c.id === data.comment.id)) {
            comments.push(data.comment);
          }
          thinkingCommentIds.add(data.comment.id);
          pendingSelection = null;
          window.getSelection()?.removeAllRanges();
          renderComments();
          applyHighlights();
          positionCards();
          updateNav();
          applyRoundState();
          // Scroll the new card into view so the user sees the save landed
          const newCard = document.getElementById('card-' + data.comment.id);
          if (newCard) newCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          showError(data.error || 'Failed to save comment');
        }
      } catch (err) {
        showError('Failed to save comment: ' + err.message);
      }
    }

    // ── Highlights ───────────────────────────────────────────────────
    // Run a DOM-mutating callback while pinning scroll position.
    // Uses requestAnimationFrame to clamp scroll for two frames after the mutation
    // — this catches focus-loss scrolls and layout-induced jumps that fire after the call returns.
    let deliberateScrollUntil = 0;
    function preserveScroll(fn) {
      // If a deliberate scroll-to is in flight (e.g. all-resolved scroll-to-top),
      // skip the pin so the SSE softRefresh doesn't override the smooth scroll.
      if (Date.now() < deliberateScrollUntil) { fn(); return; }
      const top = window.scrollY;
      const active = document.activeElement;
      if (active && active !== document.body && typeof active.blur === 'function') active.blur();
      fn();
      document.documentElement.scrollTop = top;
      requestAnimationFrame(() => {
        document.documentElement.scrollTop = top;
        requestAnimationFrame(() => { document.documentElement.scrollTop = top; });
      });
    }

    function applyHighlights() {
      preserveScroll(() => {
        const prose = document.getElementById('prose');
        prose.querySelectorAll('mark.rl-highlight').forEach(m => {
          const parent = m.parentNode;
          while (m.firstChild) parent.insertBefore(m.firstChild, m);
          parent.removeChild(m);
        });
        prose.normalize();
        comments.forEach(comment => {
          highlightText(prose, comment.quote, comment.id, comment.resolved, comment.context_before || '');
        });
      });
    }

    function highlightText(container, text, id, resolved, contextBefore) {
      // Image quote: wrap the <img> by alt match instead of text-walking
      const imgMatch = text.match(/^\\[image:\\s*(.*)\\]$/);
      if (imgMatch) {
        const alt = imgMatch[1];
        const imgs = container.querySelectorAll('img');
        for (const img of imgs) {
          if ((img.alt || '') === alt) {
            const mark = document.createElement('mark');
            mark.className = 'rl-highlight rl-img' + (resolved ? ' resolved' : '');
            mark.dataset.commentId = id;
            mark.addEventListener('click', (ev) => { ev.stopPropagation(); focusComment(id); });
            img.parentNode.insertBefore(mark, img);
            mark.appendChild(img);
            return;
          }
        }
        return;
      }

      container.normalize();

      // Build a flat string from all text nodes so we can do context-aware search
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      const segments = [];
      let flat = '';
      let node;
      while (node = walker.nextNode()) {
        segments.push({ node, start: flat.length });
        flat += node.nodeValue;
      }

      // Prefer contextBefore+text search to find the right occurrence
      let quoteStart = -1;
      if (contextBefore) {
        const ctxIdx = flat.indexOf(contextBefore + text);
        if (ctxIdx !== -1) quoteStart = ctxIdx + contextBefore.length;
      }
      if (quoteStart === -1) quoteStart = flat.indexOf(text);
      if (quoteStart === -1) return;

      const quoteEnd = quoteStart + text.length;

      // Collect all segments overlapping [quoteStart, quoteEnd] before mutating the DOM
      const toWrap = [];
      for (const seg of segments) {
        const segEnd = seg.start + seg.node.nodeValue.length;
        if (segEnd <= quoteStart || seg.start >= quoteEnd) continue;
        toWrap.push({
          node: seg.node,
          localStart: Math.max(0, quoteStart - seg.start),
          localEnd: Math.min(seg.node.nodeValue.length, quoteEnd - seg.start),
        });
      }

      // Wrap each overlapping segment — handles quotes that cross inline elements (<code>, <em>, etc.)
      toWrap.forEach(({ node, localStart, localEnd }) => {
        const mark = document.createElement('mark');
        mark.className = 'rl-highlight' + (resolved ? ' resolved' : '');
        mark.dataset.commentId = id;
        mark.addEventListener('click', () => focusComment(id));
        const mid = node.splitText(localStart);
        const after = mid.splitText(localEnd - localStart);
        mid.parentNode.insertBefore(mark, after);
        mark.appendChild(mid);
      });
    }

    let navIdx = 0; // index into the unresolved comment list

    function focusComment(id) {
      document.querySelectorAll('.comment-card').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('mark.rl-highlight').forEach(el => el.classList.remove('active'));
      const card = document.getElementById('card-' + id);
      if (card) card.classList.add('active');
      document.querySelectorAll('[data-comment-id="' + id + '"]').forEach(el => el.classList.add('active'));
      positionCards();
    }

    function clearFocus() {
      document.querySelectorAll('.comment-card').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('mark.rl-highlight').forEach(el => el.classList.remove('active'));
      positionCards();
    }

    document.addEventListener('click', (e) => {
      const inCard = e.target.closest('.comment-card, .new-comment-form');
      const inMark = e.target.closest('mark.rl-highlight');
      const inNav  = e.target.closest('#comment-nav');
      if (!inCard && !inMark && !inNav) clearFocus();
    });

    function navigateTo(id) {
      focusComment(id);
      positionCards();
      // Scroll highlight into view in the prose
      const mark = document.querySelector('[data-comment-id="' + id + '"]');
      if (mark) mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function updateNav() {
      const open = comments.filter(c => !c.resolved);
      const nav = document.getElementById('comment-nav');
      const countEl = document.getElementById('nav-count');
      const prevBtn = document.getElementById('nav-prev');
      const nextBtn = document.getElementById('nav-next');
      if (open.length === 0) { nav.style.display = 'none'; return; }
      nav.style.display = 'flex';
      navIdx = Math.min(navIdx, open.length - 1);
      if (open.length === 1) {
        countEl.textContent = '1 open';
        prevBtn.style.display = 'none';
        nextBtn.textContent = 'Jump to comment ↓';
        nextBtn.disabled = false;
        nextBtn.style.display = '';
      } else {
        countEl.textContent = (navIdx + 1) + ' / ' + open.length + ' open';
        prevBtn.style.display = '';
        prevBtn.textContent = '↑ Prev';
        nextBtn.textContent = 'Next ↓';
        prevBtn.disabled = navIdx === 0;
        nextBtn.disabled = navIdx === open.length - 1;
      }
      navigateTo(open[navIdx].id);
    }

    document.getElementById('nav-prev').addEventListener('click', () => {
      if (navIdx > 0) { navIdx--; updateNav(); }
    });
    document.getElementById('nav-next').addEventListener('click', () => {
      const open = comments.filter(c => !c.resolved);
      if (open.length === 1) {
        navigateTo(open[0].id);
      } else if (navIdx < open.length - 1) {
        navIdx++;
        updateNav();
      }
    });

    function positionCards() {
      const sidebarCol = document.querySelector('.sidebar-col');
      if (!sidebarCol) return;
      const sidebarRect = sidebarCol.getBoundingClientRect();

      const items = [];
      let fallbackTop = 0;
      comments.forEach(comment => {
        const card = document.getElementById('card-' + comment.id);
        if (!card) return;
        const mark = document.querySelector('[data-comment-id="' + comment.id + '"]');
        let ideal;
        if (mark) {
          const markRect = mark.getBoundingClientRect();
          ideal = Math.max(0, markRect.top - sidebarRect.top);
          fallbackTop = Math.max(fallbackTop, ideal + card.offsetHeight + 14);
        } else {
          // No highlight anchor (e.g. read-only view of past round) — stack sequentially
          ideal = fallbackTop;
          fallbackTop += card.offsetHeight + 14;
        }
        items.push({
          el: card,
          ideal,
          active: card.classList.contains('active'),
        });
      });

      // Treat the open new-comment-form as an active anchor so cards cascade
      // around it instead of overlapping. It always wins activeness.
      const form = document.getElementById('new-comment-form');
      if (form) {
        const pendingMark = document.querySelector('[data-comment-id="pending"]');
        let ideal;
        if (pendingMark) {
          ideal = Math.max(0, pendingMark.getBoundingClientRect().top - sidebarRect.top);
        } else if (pendingSelection?._rectTop != null) {
          ideal = Math.max(0, pendingSelection._rectTop - sidebarRect.top);
        } else {
          ideal = parseFloat(form.style.top) || 0;
        }
        // Demote any previously-active card so the form takes the active slot
        items.forEach(item => { item.active = false; });
        items.push({ el: form, ideal, active: true });
      }

      if (items.length === 0) return;
      items.sort((a, b) => a.ideal - b.ideal);

      const activeIdx = items.findIndex(item => item.active);

      if (activeIdx === -1) {
        // No active card — simple downward cascade
        let minTop = 0;
        items.forEach(({ el, ideal }) => {
          const top = Math.max(ideal, minTop);
          el.style.top = top + 'px';
          minTop = top + el.offsetHeight + 14;
        });
        return;
      }

      // Active card gets its ideal position; others cascade around it
      const active = items[activeIdx];
      active.el.style.top = active.ideal + 'px';

      // Cards above: cascade upward from active card's top edge
      let ceiling = active.ideal - 14;
      for (let i = activeIdx - 1; i >= 0; i--) {
        const { el, ideal } = items[i];
        const top = Math.max(0, Math.min(ideal, ceiling - el.offsetHeight));
        el.style.top = top + 'px';
        ceiling = top - 14;
      }

      // Cards below: cascade downward from active card's bottom edge
      let floor = active.ideal + active.el.offsetHeight + 14;
      for (let i = activeIdx + 1; i < items.length; i++) {
        const { el, ideal } = items[i];
        const top = Math.max(ideal, floor);
        el.style.top = top + 'px';
        floor = top + el.offsetHeight + 14;
      }
    }

    // ── Comments sidebar ─────────────────────────────────────────────
    function renderComments() {
      preserveScroll(() => {
        const sidebar = document.querySelector('.sidebar-col');

        // Remove existing cards (not the new-comment-form)
        sidebar.querySelectorAll('.comment-card').forEach(el => el.remove());

        comments.forEach(comment => {
          sidebar.appendChild(buildCommentCard(comment));
        });
      });
    }

    function buildCommentCard(comment) {
      const card = document.createElement('div');
      card.className = 'comment-card' + (comment.resolved ? ' resolved' : '');
      card.id = 'card-' + comment.id;

      const quote = document.createElement('div');
      quote.className = 'comment-quote';
      if (comment.resolved) {
        const badge = document.createElement('span');
        badge.className = 'resolved-badge';
        badge.textContent = '✓ Resolved';
        quote.appendChild(badge);
      }
      quote.appendChild(document.createTextNode('"' + comment.quote + '"'));
      card.appendChild(quote);

      // For resolved cards: show a short commitment summary (visible when collapsed).
      // Take the first sentence of the last agent reply, capped at 140 chars.
      if (comment.resolved) {
        const lastAgentMsg = [...comment.thread].reverse().find(e => e.role === 'agent');
        if (lastAgentMsg) {
          const full = lastAgentMsg.message;
          const sentenceEnd = full.search(/[.!?](\\s|$)/);
          let summary = sentenceEnd !== -1 ? full.slice(0, sentenceEnd + 1) : full;
          if (summary.length > 140) summary = summary.slice(0, 137).trimEnd() + '…';
          const commitment = document.createElement('div');
          commitment.className = 'card-commitment';
          commitment.textContent = summary;
          card.appendChild(commitment);
        }
      }

      const thread = document.createElement('div');
      thread.className = 'comment-thread';
      thread.id = 'thread-' + comment.id;
      comment.thread.forEach(entry => {
        thread.appendChild(buildThreadEntry(entry));
      });
      if (thinkingCommentIds.has(comment.id)) {
        const indicator = document.createElement('div');
        indicator.className = 'thread-entry thinking-indicator';
        indicator.innerHTML = '<div class="thread-role agent">Agent</div><div class="thread-message thinking-dots"><span></span><span></span><span></span></div>';
        thread.appendChild(indicator);
      }
      // Wrap thread, actions, reply form in .comment-body (hidden when resolved + collapsed)
      const body = document.createElement('div');
      body.className = 'comment-body';

      body.appendChild(thread);

      const actions = document.createElement('div');
      actions.className = 'comment-actions';

      if (!comment.resolved && !roundResolved) {
        const replyBtn = document.createElement('button');
        replyBtn.className = 'btn-reply';
        replyBtn.textContent = 'Reply';
        replyBtn.addEventListener('click', () => toggleReplyForm(comment.id));
        actions.appendChild(replyBtn);

        const resolveBtn = document.createElement('button');
        resolveBtn.className = 'btn-resolve-comment';
        resolveBtn.textContent = 'Resolve';
        resolveBtn.addEventListener('click', () => resolveComment(comment.id));
        actions.appendChild(resolveBtn);
      }

      if (comment.resolved && !roundResolved) {
        const reopenBtn = document.createElement('button');
        reopenBtn.className = 'btn-reopen';
        reopenBtn.textContent = 'Reopen';
        reopenBtn.addEventListener('click', () => reopenComment(comment.id));
        actions.appendChild(reopenBtn);
      }

      body.appendChild(actions);

      const replyForm = document.createElement('div');
      replyForm.className = 'reply-form';
      replyForm.id = 'reply-' + comment.id;
      replyForm.innerHTML = \`
        <textarea class="reply-input" placeholder="Reply…"></textarea>
        <button class="reply-submit">Send <kbd>⌘↵</kbd></button>
      \`;
      replyForm.querySelector('.reply-submit').addEventListener('click', () => {
        submitReply(comment.id, replyForm.querySelector('.reply-input').value.trim());
      });
      replyForm.querySelector('.reply-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          submitReply(comment.id, replyForm.querySelector('.reply-input').value.trim());
        }
      });
      body.appendChild(replyForm);

      card.appendChild(body);

      // Resolved cards: click quote to expand/collapse; other clicks focus
      if (comment.resolved) {
        quote.addEventListener('click', (e) => {
          e.stopPropagation();
          card.classList.toggle('expanded');
          positionCards();
        });
      }

      card.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'TEXTAREA') return;
        if (comment.resolved) return; // handled by quote click
        focusComment(comment.id);
      });

      return card;
    }

    function buildThreadEntry(entry) {
      const role = entry.role ?? 'agent';
      const label = entry.name ?? (role === 'agent' ? 'Agent' : 'Human');
      const div = document.createElement('div');
      div.className = 'thread-entry';
      div.innerHTML = \`
        <div class="thread-role \${role}">\${escapeHtml(label)}</div>
        <div class="thread-message">\${escapeHtml(entry.message)}</div>
      \`;
      return div;
    }

    function escapeHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function toggleReplyForm(id) {
      const form = document.getElementById('reply-' + id);
      const card = document.getElementById('card-' + id);
      form.classList.toggle('open');
      if (form.classList.contains('open')) {
        form.querySelector('.reply-input').focus();
        if (card) card.style.zIndex = '1';
      } else {
        if (card) card.style.zIndex = '';
      }
      // Card height changed — re-cascade so siblings shift instead of overlapping.
      positionCards();
    }

    async function submitReply(id, message) {
      if (!message) return;
      try {
        const res = await fetch('/api/comment/' + id + '/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'human', message }),
        });
        const data = await res.json();
        if (data.ok) {
          const idx = comments.findIndex(c => c.id === id);
          if (idx !== -1) comments[idx] = data.comment;
          thinkingCommentIds.add(id);
          renderComments();
          positionCards();
          updateNav();
        } else {
          showError(data.error || 'Failed to save reply');
        }
      } catch (err) {
        showError('Failed to save reply: ' + err.message);
      }
    }

    async function resolveComment(id) {
      try {
        const res = await fetch('/api/comment/' + id + '/resolve', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          const c = comments.find(c => c.id === id);
          if (c) c.resolved = true;
          navIdx = 0;
          renderComments();
          applyHighlights();
          positionCards();
          updateNav();
          applyRoundState();
          if (data.allResolved) {
            deliberateScrollUntil = Date.now() + 1200;
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }
        } else {
          showError(data.error || 'Failed to resolve comment');
        }
      } catch (err) {
        showError('Failed to resolve: ' + err.message);
      }
    }

    async function reopenComment(id) {
      try {
        const res = await fetch('/api/comment/' + id + '/reopen', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          const idx = comments.findIndex(c => c.id === id);
          if (idx !== -1) comments[idx] = data.comment;
          renderComments();
          applyHighlights();
          positionCards();
          updateNav();
          applyRoundState();
        } else {
          showError(data.error || 'Failed to reopen comment');
        }
      } catch (err) {
        showError('Failed to reopen: ' + err.message);
      }
    }

    function showError(msg) {
      const el = document.getElementById('error-banner');
      el.textContent = msg;
      el.style.display = 'block';
      setTimeout(() => el.style.display = 'none', 4000);
    }

    // ── Round state display ──────────────────────────────────────────
    function applyRoundState() {
      const btnAccept = document.getElementById('btn-accept');
      const banner = document.getElementById('sidebar-status-banner');
      if (!btnAccept) return; // read-only view

      // If a revision error is currently surfaced, leave the banner alone —
      // it gets cleared explicitly when the user retries the revision.
      const errorShowing = !!banner?.classList.contains('error');

      if (roundResolved) {
        document.getElementById('empty-rail-hint')?.remove();
        btnAccept.disabled = true;
        btnAccept.textContent = '✓ Accepted';
        if (banner && !errorShowing) {
          banner.innerHTML = '<div class="revising-header"><span class="revising-spinner"></span><span>Revising the document<span class="revising-dots"><span>.</span><span>.</span><span>.</span></span></span></div><div id="revision-stream"></div>';
          banner.classList.add('revising');
          banner.style.display = 'flex';
        }
        renderComments();
        positionCards();
        updateNav();
      } else if (comments.length === 0) {
        btnAccept.disabled = false;
        // Cold-open (round 1, never commented) reads as "Skip review";
        // an empty round after a revision is a real "Done — accept this version".
        const isColdOpen = totalRounds <= 1;
        btnAccept.textContent = isColdOpen ? 'Skip review' : 'Done';
        btnAccept.dataset.mode = 'finish';
        if (banner && !errorShowing) {
          banner.classList.remove('revising');
          banner.style.display = 'none';
        }
        // Surface a subtle "Select text to leave a comment" hint on cold open.
        const hint = document.getElementById('empty-rail-hint');
        if (isColdOpen) {
          if (!hint) {
            const rail = document.querySelector('.sidebar-col');
            if (rail) {
              const el = document.createElement('div');
              el.id = 'empty-rail-hint';
              el.className = 'empty-rail-hint';
              el.textContent = 'Select text to leave a comment.';
              rail.appendChild(el);
            }
          }
        } else if (hint) {
          hint.remove();
        }
      } else {
        document.getElementById('empty-rail-hint')?.remove();
        const hasOpen = comments.some(c => !c.resolved);
        btnAccept.disabled = hasOpen;
        btnAccept.dataset.mode = 'accept';
        btnAccept.textContent = hasOpen ? 'Revise document' : 'Revise document ✓';
        if (banner && !errorShowing) {
          banner.classList.remove('revising');
          if (!hasOpen) {
            banner.textContent = 'All comments resolved — ready to accept.';
            banner.style.display = 'block';
          } else {
            banner.style.display = 'none';
          }
        }
      }
    }

    document.getElementById('btn-accept')?.addEventListener('click', async () => {
      const btnAccept = document.getElementById('btn-accept');
      if (btnAccept?.disabled) return;
      const mode = btnAccept.dataset.mode;
      // Clear any prior error banner so a retry shows the revising state cleanly
      const banner = document.getElementById('sidebar-status-banner');
      if (banner) {
        banner.classList.remove('error');
        banner.style.display = 'none';
        banner.textContent = '';
      }
      const endpoint = mode === 'finish' ? '/api/finish' : '/api/accept';
      const res = await fetch(endpoint, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        roundResolved = true;
        if (mode === 'finish') {
          btnAccept.disabled = true;
          btnAccept.textContent = '✓ Done';
          const banner = document.getElementById('sidebar-status-banner');
          if (banner) {
            banner.classList.remove('revising'); banner.classList.remove('error');
            banner.textContent = 'Review complete. Document is ready.';
            banner.style.display = 'block';
          }
        } else {
          applyRoundState();
        }
      } else {
        alert(data.error || 'Could not complete.');
      }
    });

    // ── Revision banner ──────────────────────────────────────────────
    function showRevisionBanner() {
      if (document.getElementById('revision-banner')) return;
      const banner = document.createElement('div');
      banner.id = 'revision-banner';
      banner.className = 'revision-banner';
      banner.innerHTML = '<span class="revision-banner-text">Document revised.</span>' +
        '<button class="revision-banner-link" id="revision-banner-diff">See what changed →</button>' +
        '<button class="revision-banner-dismiss" aria-label="Dismiss">✕</button>';
      banner.querySelector('#revision-banner-diff').addEventListener('click', () => {
        banner.remove();
        showDiffOverlay();
      });
      banner.querySelector('.revision-banner-dismiss').addEventListener('click', () => banner.remove());
      const prose = document.getElementById('prose');
      prose.parentNode.insertBefore(banner, prose);
    }

    // ── Diff overlay ─────────────────────────────────────────────────
    async function showDiffOverlay() {
      const res = await fetch('/api/diff');
      const data = await res.json();
      if (!data.ok) return;
      document.getElementById('diff-panel-body').innerHTML = data.html;
      document.getElementById('diff-overlay').classList.add('open');
    }

    document.getElementById('btn-compare')?.addEventListener('click', () => showDiffOverlay());

    document.getElementById('diff-btn-accept').addEventListener('click', async () => {
      document.getElementById('diff-overlay').classList.remove('open');
      await fetch('/api/finish', { method: 'POST' });
      const btnAccept = document.getElementById('btn-accept');
      if (btnAccept) { btnAccept.disabled = true; btnAccept.textContent = '✓ Done'; }
      const banner = document.getElementById('sidebar-status-banner');
      if (banner) {
        banner.classList.remove('revising');
        banner.textContent = 'Review complete. Document is ready.';
        banner.style.display = 'block';
      }
    });

    document.getElementById('diff-btn-feedback').addEventListener('click', () => {
      document.getElementById('diff-overlay').classList.remove('open');
    });

    document.getElementById('diff-btn-close')?.addEventListener('click', () => {
      document.getElementById('diff-overlay').classList.remove('open');
    });

    // ── Round picker ─────────────────────────────────────────────────
    const roundBadge = document.getElementById('round-badge');
    const roundPicker = document.getElementById('round-picker');
    if (roundBadge && roundPicker) {
      roundBadge.addEventListener('click', (e) => {
        e.stopPropagation();
        roundPicker.style.display = roundPicker.style.display === 'none' ? 'block' : 'none';
      });
      document.addEventListener('click', () => { roundPicker.style.display = 'none'; });
    }

    // ── Context banner ───────────────────────────────────────────────
    function dismissContextBanner() {
      const banner = document.getElementById('context-banner');
      if (banner) banner.remove();
      try { localStorage.setItem('rl-ctx-dismissed-' + ${JSON.stringify(title)}, '1'); } catch {}
    }
    (function() {
      const banner = document.getElementById('context-banner');
      if (!banner) return;
      try {
        if (localStorage.getItem('rl-ctx-dismissed-' + ${JSON.stringify(title)})) banner.remove();
      } catch {}
    })();

    // Replace broken images with a styled placeholder showing the alt text.
    function swapBrokenImg(img) {
      const placeholder = document.createElement('div');
      placeholder.className = 'broken-img';
      placeholder.textContent = 'Image failed to load' + (img.alt ? ': ' + img.alt : '');
      img.replaceWith(placeholder);
    }
    document.querySelectorAll('#prose img').forEach(img => {
      img.addEventListener('error', () => swapBrokenImg(img));
      // Image may already have errored before our listener attached (cached failure,
      // or the request raced ahead of script eval). Detect via the standard pattern.
      if (img.complete && img.naturalWidth === 0) swapBrokenImg(img);
    });

    // ── Init ─────────────────────────────────────────────────────────
    renderComments();
    applyHighlights();
    positionCards();
    updateNav();
    applyRoundState();
    if (sessionStorage.getItem('just-revised')) {
      sessionStorage.removeItem('just-revised');
      showRevisionBanner();
    }
    if (sessionStorage.getItem('rl-no-changes')) {
      sessionStorage.removeItem('rl-no-changes');
      const banner = document.getElementById('sidebar-status-banner');
      if (banner) {
        banner.classList.remove('revising'); banner.classList.remove('error');
        banner.textContent = 'No changes — the document is unchanged.';
        banner.style.display = 'block';
        setTimeout(() => { banner.style.display = 'none'; }, 5000);
      }
    }
    window.addEventListener('scroll', positionCards, { passive: true });
    window.addEventListener('resize', positionCards, { passive: true });

    // ── SSE auto-reload ───────────────────────────────────────────────
    async function softRefresh({ rehighlight = false } = {}) {
      try {
        const res = await fetch('/api/comments');
        const data = await res.json();
        comments = data.comments;
        roundResolved = data.roundResolved;
        renderComments();
        if (rehighlight) applyHighlights();
        positionCards();
        updateNav();
        applyRoundState();
      } catch { /* non-fatal */ }
    }

    (function connectEvents() {
      const es = new EventSource('/api/events?client=browser');
      es.addEventListener('comment-thinking', (e) => {
        try { thinkingCommentIds.add(JSON.parse(e.data).commentId); } catch {}
        renderComments();
        positionCards();
        updateNav();
      });
      es.addEventListener('agent-replied', () => { thinkingCommentIds.clear(); softRefresh(); });
      es.addEventListener('comment-added', () => softRefresh({ rehighlight: true }));
      es.addEventListener('comment-reply', (e) => {
        try { thinkingCommentIds.delete(JSON.parse(e.data).commentId); } catch {}
        softRefresh();
      });
      es.addEventListener('comment-resolved', () => softRefresh({ rehighlight: true }));
      es.addEventListener('reload', () => { sessionStorage.setItem('just-revised', '1'); window.location.reload(); });
      es.addEventListener('revision-chunk', (e) => {
        try {
          const { text, kind } = JSON.parse(e.data);
          const stream = document.getElementById('revision-stream');
          if (stream) {
            if (stream.style.display === 'none' || !stream.style.display) stream.style.display = 'block';
            const span = document.createElement('span');
            span.className = kind === 'thinking' ? 'rs-thinking' : 'rs-text';
            span.textContent = text;
            stream.appendChild(span);
            stream.scrollTop = stream.scrollHeight;
          }
        } catch {}
      });
      es.addEventListener('revision-error', (e) => {
        let msg = 'Revision failed.';
        try { msg = 'Revision failed: ' + (JSON.parse(e.data).message ?? 'unknown error'); } catch {}
        softRefresh();
        const banner = document.getElementById('sidebar-status-banner');
        if (banner) {
          banner.classList.remove('revising'); banner.classList.remove('error');
          banner.classList.add('error');
          banner.textContent = msg + ' Click "Revise document" to retry.';
          banner.style.display = 'block';
        }
      });
      es.addEventListener('revision-no-changes', () => {
        // Stash the message and reload so the round badge / state catches up.
        // The init code below picks up the flag and surfaces the banner briefly.
        try { sessionStorage.setItem('rl-no-changes', '1'); } catch {}
        window.location.reload();
      });
      es.addEventListener('finished', () => {
        document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;flex-direction:column;gap:16px;color:#374151"><div style="font-size:48px">✓</div><div style="font-size:20px;font-weight:600">Review complete</div><div style="color:#6b7280">You can close this tab and continue in Claude Code.</div></div>';
      });
      es.onerror = () => { es.close(); setTimeout(connectEvents, 3000); };
    })();
  </script>
</body>
</html>`;
}
