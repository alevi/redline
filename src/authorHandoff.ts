import { existsSync, readFileSync } from "fs";
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "fs/promises";
import { createHash } from "crypto";
import path from "path";
import {
  loadSidecar,
  withSidecar,
  type Comment,
  type Sidecar,
  type ThreadEntry,
} from "./sidecar";
import { validateRevision } from "./resolve";

export interface AuthorNeededItem {
  round: number;
  commentId: string;
  quote: string;
  request: string;
  note: string;
  resolved: boolean;
}

export interface CallerTurnItem {
  round: number;
  commentId: string;
  quote: string;
  contextBefore: string;
  contextAfter: string;
  request: string;
  thread: ThreadEntry[];
  resolved: boolean;
}

export interface CallerRevisionRequest {
  round: number;
  revision_file: string;
  context?: string;
  comments: Comment[];
}

function flatten(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1).trimEnd() + "…" : flat;
}

function latestIndex(
  thread: ThreadEntry[],
  predicate: (entry: ThreadEntry) => boolean,
): number {
  for (let i = thread.length - 1; i >= 0; i--) {
    if (predicate(thread[i]!)) return i;
  }
  return -1;
}

export function collectAuthorNeeded(sidecar: Sidecar): AuthorNeededItem[] {
  const items: AuthorNeededItem[] = [];
  for (const round of sidecar.rounds) {
    for (const comment of round.comments) {
      const escIdx = latestIndex(
        comment.thread,
        (entry) => entry.role === "agent" && entry.escalate === true,
      );
      if (escIdx === -1) continue;
      const authorIdx = latestIndex(
        comment.thread,
        (entry) => entry.role === "agent" && entry.author === true,
      );
      if (authorIdx > escIdx) continue;

      const agentEntry = comment.thread[escIdx]!;
      let request = "";
      for (let i = escIdx - 1; i >= 0; i--) {
        if (comment.thread[i]!.role === "human") {
          request = comment.thread[i]!.message;
          break;
        }
      }

      items.push({
        round: round.round,
        commentId: comment.id,
        quote: flatten(comment.quote, 120),
        request: flatten(request, 500),
        note: flatten(agentEntry.revision_reason || agentEntry.message, 500),
        resolved: comment.resolved,
      });
    }
  }
  return items;
}

export async function listAuthorNeeded(
  filePath: string,
): Promise<AuthorNeededItem[]> {
  return collectAuthorNeeded(await loadSidecar(filePath));
}

export function collectCallerTurns(sidecar: Sidecar): CallerTurnItem[] {
  const active = sidecar.rounds.find((round) => round.resolved_at === null);
  if (!active) return [];

  return active.comments.flatMap((comment) => {
    const latest = comment.thread.at(-1);
    if (!latest || latest.role !== "human" || comment.resolved) return [];
    return [
      {
        round: active.round,
        commentId: comment.id,
        quote: comment.quote,
        contextBefore: comment.context_before,
        contextAfter: comment.context_after,
        request: latest.message,
        thread: comment.thread,
        resolved: comment.resolved,
      },
    ];
  });
}

export async function listCallerTurns(
  filePath: string,
): Promise<CallerTurnItem[]> {
  return collectCallerTurns(await loadSidecar(filePath));
}

export interface AuthorReplyResult {
  via: "server" | "sidecar";
  commentId: string;
}

export type AuthorWaitResult =
  | { kind: "caller-turn"; file: string; caller_turns: CallerTurnItem[] }
  | {
      kind: "revision-request";
      file: string;
      revision: CallerRevisionRequest;
    }
  | { kind: "author-needed"; file: string; author_needed: AuthorNeededItem[] }
  | { kind: "result"; file: string; result: Record<string, unknown> }
  | { kind: "session-ended"; file: string; pid: number; message: string };

function startupPath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    ".review",
    path.basename(filePath) + ".startup.json",
  );
}

function resultPath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    ".review",
    path.basename(filePath) + ".result",
  );
}

function readStartup(filePath: string): {
  url?: string;
  csrf_token?: string;
  pid?: number;
  responder_mode?: string;
} | null {
  const sp = startupPath(filePath);
  if (!existsSync(sp)) return null;
  try {
    return JSON.parse(readFileSync(sp, "utf-8")) as {
      url?: string;
      csrf_token?: string;
      pid?: number;
      responder_mode?: string;
    };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    // EPERM means the process exists but this user cannot signal it.
    return code === "EPERM";
  }
}

async function postToLiveServer(
  filePath: string,
  commentId: string,
  message: string,
  name: string,
  verdict: { requiresRevision?: boolean; revisionReason?: string },
): Promise<boolean> {
  const startup = readStartup(filePath);
  if (!startup?.url || !startup.csrf_token) return false;
  try {
    const res = await fetch(
      `${startup.url}/api/comment/${encodeURIComponent(commentId)}/reply`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Redline-Token": startup.csrf_token,
        },
        body: JSON.stringify({
          role: "agent",
          name,
          message,
          author: true,
          requires_revision: verdict.requiresRevision,
          revision_reason: verdict.revisionReason,
        }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

function findComment(sidecar: Sidecar, commentId: string): Comment | null {
  for (const round of sidecar.rounds) {
    const found = round.comments.find((comment) => comment.id === commentId);
    if (found) return found;
  }
  return null;
}

export async function postAuthorReply(
  filePath: string,
  commentId: string,
  message: string,
  options: {
    name?: string;
    requiresRevision?: boolean;
    revisionReason?: string;
  } = {},
): Promise<AuthorReplyResult> {
  const trimmed = message.trim();
  if (!trimmed) throw new Error("message is required");
  const name = options.name?.trim() || "Author";

  const revisionReason = options.revisionReason?.trim() || undefined;
  if (
    await postToLiveServer(filePath, commentId, trimmed, name, {
      requiresRevision: options.requiresRevision,
      revisionReason,
    })
  ) {
    return { via: "server", commentId };
  }

  const result = await withSidecar(filePath, (sidecar) => {
    const comment = findComment(sidecar, commentId);
    if (!comment) return { ok: false as const };
    comment.thread.push({
      role: "agent",
      name,
      message: trimmed,
      at: new Date().toISOString(),
      author: true,
      requires_revision: options.requiresRevision,
      revision_reason: revisionReason,
    });
    return { ok: true as const };
  });
  if (!result.ok) throw new Error(`Comment not found: ${commentId}`);
  return { via: "sidecar", commentId };
}

async function postThinkingToLiveServer(
  filePath: string,
  commentId: string,
): Promise<void> {
  const startup = readStartup(filePath);
  if (!startup?.url || !startup.csrf_token) return;
  try {
    await fetch(
      `${startup.url}/api/comment/${encodeURIComponent(commentId)}/thinking`,
      {
        method: "POST",
        headers: { "X-Redline-Token": startup.csrf_token },
      },
    );
  } catch {
    // The wait result is still useful if the browser disconnected meanwhile.
  }
}

export async function postCallerHeartbeat(filePath: string): Promise<boolean> {
  const startup = readStartup(filePath);
  if (!startup?.url || !startup.csrf_token) return false;
  try {
    const res = await fetch(`${startup.url}/api/caller-heartbeat`, {
      method: "POST",
      headers: { "X-Redline-Token": startup.csrf_token },
    });
    return res.ok;
  } catch {
    return false;
  }
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function candidatePath(filePath: string, round: number): string {
  return path.join(
    path.dirname(filePath),
    ".review",
    "pending",
    `${path.basename(filePath)}.round-${round}.md`,
  );
}

export async function prepareCallerRevision(
  filePath: string,
): Promise<CallerRevisionRequest | null> {
  const result = await withSidecar<CallerRevisionRequest | false>(
    filePath,
    async (sidecar) => {
      if (sidecar.responder_mode !== "caller") return false as const;
      const round = [...sidecar.rounds]
        .reverse()
        .find(
          (item) =>
            item.resolved_at !== null && item.caller_revision_requested_at,
        );
      if (!round) return false as const;

      const revisionFile = candidatePath(filePath, round.round);
      const existing = sidecar.pending_revision;
      if (!existing || existing.round !== round.round) {
        const source = await readFile(filePath, "utf-8");
        await mkdir(path.dirname(revisionFile), { recursive: true });
        await writeFile(revisionFile, source, "utf-8");
        sidecar.pending_revision = {
          round: round.round,
          candidate_file: revisionFile,
          source_hash: hashText(source),
          prepared_at: new Date().toISOString(),
        };
      } else if (
        path.resolve(existing.candidate_file) !== path.resolve(revisionFile)
      ) {
        throw new Error(
          "Pending revision file is outside Redline's staging path",
        );
      } else if (!existsSync(existing.candidate_file)) {
        const source = await readFile(filePath, "utf-8");
        if (hashText(source) !== existing.source_hash) {
          throw new Error(
            "The document changed after the caller revision was prepared",
          );
        }
        await mkdir(path.dirname(existing.candidate_file), { recursive: true });
        await writeFile(existing.candidate_file, source, "utf-8");
      }

      const pending = sidecar.pending_revision!;
      return {
        round: round.round,
        revision_file: pending.candidate_file,
        context: sidecar.context,
        comments: round.comments.filter((comment) => comment.resolved),
      };
    },
  );
  return result === false ? null : result;
}

async function postRevisionTerminalEvent(
  filePath: string,
  event: "reload" | "revision-no-changes" | "revision-error",
  message?: string,
): Promise<boolean> {
  const startup = readStartup(filePath);
  if (!startup?.url || !startup.csrf_token) return false;
  try {
    const res = await fetch(`${startup.url}/api/${event}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Redline-Token": startup.csrf_token,
      },
      body:
        event === "revision-error" ? JSON.stringify({ message }) : undefined,
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function logCallerRevisionFailure(
  filePath: string,
  reason: string,
): Promise<void> {
  const logDir = path.join(path.dirname(filePath), ".review");
  await mkdir(logDir, { recursive: true });
  await appendFile(
    path.join(logDir, "errors.log"),
    `\n=== ${new Date().toISOString()} — caller revision failure ===\nfile:    ${path.resolve(filePath)}\nreason:  ${reason}\n===\n`,
    "utf-8",
  ).catch(() => {});
}

export async function failCallerRevision(
  filePath: string,
  reason: string,
): Promise<void> {
  await logCallerRevisionFailure(filePath, reason);
  const notified = await postRevisionTerminalEvent(
    filePath,
    "revision-error",
    reason,
  );
  if (notified) return;
  await withSidecar(filePath, (sidecar) => {
    const pendingRound = sidecar.pending_revision?.round;
    const round = sidecar.rounds.find((item) => item.round === pendingRound);
    if (round) {
      round.resolved_at = null;
      delete round.caller_revision_requested_at;
    }
    delete sidecar.pending_revision;
  });
}

export async function completeCallerRevision(
  filePath: string,
  roundNumber: number,
): Promise<{ changed: boolean; round: number }> {
  let candidateFile = "";
  try {
    await postCallerHeartbeat(filePath);
    const result = await withSidecar(filePath, async (sidecar) => {
      if (sidecar.responder_mode !== "caller") {
        throw new Error("This review is not using the caller responder");
      }
      const pending = sidecar.pending_revision;
      if (!pending || pending.round !== roundNumber) {
        throw new Error(`No pending caller revision for round ${roundNumber}`);
      }
      if (
        path.resolve(pending.candidate_file) !==
        path.resolve(candidatePath(filePath, roundNumber))
      ) {
        throw new Error(
          "Pending revision file is outside Redline's staging path",
        );
      }
      candidateFile = pending.candidate_file;
      const round = sidecar.rounds.find((item) => item.round === roundNumber);
      if (
        !round ||
        round.resolved_at === null ||
        !round.caller_revision_requested_at
      ) {
        throw new Error(`Round ${roundNumber} is not awaiting caller revision`);
      }

      const [source, proposed] = await Promise.all([
        readFile(filePath, "utf-8"),
        readFile(candidateFile, "utf-8"),
      ]);
      if (hashText(source) !== pending.source_hash) {
        throw new Error(
          "The document changed after the caller revision was prepared",
        );
      }

      const settled = round.comments.filter((comment) => comment.resolved);
      const validation = validateRevision(proposed, source, settled);
      if (!validation.ok) throw new Error(validation.reason);

      const historyDir = path.join(
        path.dirname(filePath),
        ".review",
        "history",
      );
      await mkdir(historyDir, { recursive: true });
      const snapshot = path.join(
        historyDir,
        `${path.basename(filePath)}.${new Date().toISOString()}.md`,
      );
      await copyFile(filePath, snapshot);

      const changed = validation.doc !== source.trim();
      if (changed) await writeFile(filePath, validation.doc, "utf-8");

      delete round.caller_revision_requested_at;
      delete sidecar.pending_revision;
      if (!sidecar.rounds.some((item) => item.resolved_at === null)) {
        sidecar.rounds.push({
          round: sidecar.rounds.length + 1,
          started_at: new Date().toISOString(),
          submitted_at: null,
          agent_replied_at: null,
          resolved_at: null,
          comments: [],
        });
      }
      return { changed, round: roundNumber };
    });

    await rm(candidateFile, { force: true }).catch(() => {});
    await postRevisionTerminalEvent(
      filePath,
      result.changed ? "reload" : "revision-no-changes",
    );
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await failCallerRevision(filePath, reason);
    throw error;
  }
}

export function formatAuthorNeeded(items: AuthorNeededItem[]): string {
  if (items.length === 0) return "No author replies needed.";
  const lines = [
    `${items.length} comment${items.length === 1 ? " needs an author reply" : "s need author replies"}:`,
  ];
  for (const item of items) {
    lines.push(
      `- ${item.commentId} (round ${item.round}${item.resolved ? ", resolved" : ", open"}): "${item.quote}"`,
    );
    if (item.request) lines.push(`  Reviewer: ${item.request}`);
    if (item.note) lines.push(`  Inline agent: ${item.note}`);
  }
  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForAuthorEvent(
  filePath: string,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<AuthorWaitResult> {
  const intervalMs = Math.max(50, options.intervalMs ?? 500);
  const deadline =
    options.timeoutMs != null ? Date.now() + options.timeoutMs : null;
  const rp = resultPath(filePath);

  while (true) {
    const startup = readStartup(filePath);
    const sidecar = await loadSidecar(filePath);
    const callerBacked =
      startup?.responder_mode === "caller" ||
      sidecar.responder_mode === "caller";

    if (callerBacked) {
      await postCallerHeartbeat(filePath);
      const callerTurns = collectCallerTurns(sidecar);
      if (callerTurns.length > 0) {
        await Promise.all(
          callerTurns.map((turn) =>
            postThinkingToLiveServer(filePath, turn.commentId),
          ),
        );
        return {
          kind: "caller-turn",
          file: filePath,
          caller_turns: callerTurns,
        };
      }

      const revision = await prepareCallerRevision(filePath);
      if (revision) {
        return {
          kind: "revision-request",
          file: filePath,
          revision,
        };
      }
    }

    if (!callerBacked) {
      const authorNeeded = await listAuthorNeeded(filePath);
      if (authorNeeded.length > 0) {
        return {
          kind: "author-needed",
          file: filePath,
          author_needed: authorNeeded,
        };
      }
    }

    if (existsSync(rp)) {
      const raw = await readFile(rp, "utf-8");
      return {
        kind: "result",
        file: filePath,
        result: JSON.parse(raw) as Record<string, unknown>,
      };
    }

    if (typeof startup?.pid === "number" && !processIsAlive(startup.pid)) {
      return {
        kind: "session-ended",
        file: filePath,
        pid: startup.pid,
        message: "Redline session process ended before writing a result.",
      };
    }

    if (deadline != null && Date.now() >= deadline) {
      throw new Error(
        "Timed out waiting for caller work, author-needed comments, or review result",
      );
    }
    await sleep(intervalMs);
  }
}
