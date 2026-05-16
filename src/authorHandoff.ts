import { existsSync, readFileSync } from "fs";
import path from "path";
import { loadSidecar, withSidecar, type Comment, type Sidecar, type ThreadEntry } from "./sidecar";

export interface AuthorNeededItem {
  round: number;
  commentId: string;
  quote: string;
  request: string;
  note: string;
  resolved: boolean;
}

function flatten(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1).trimEnd() + "…" : flat;
}

function latestIndex(thread: ThreadEntry[], predicate: (entry: ThreadEntry) => boolean): number {
  for (let i = thread.length - 1; i >= 0; i--) {
    if (predicate(thread[i]!)) return i;
  }
  return -1;
}

export function collectAuthorNeeded(sidecar: Sidecar): AuthorNeededItem[] {
  const items: AuthorNeededItem[] = [];
  for (const round of sidecar.rounds) {
    for (const comment of round.comments) {
      const escIdx = latestIndex(comment.thread, (entry) => entry.role === "agent" && entry.escalate === true);
      if (escIdx === -1) continue;
      const authorIdx = latestIndex(comment.thread, (entry) => entry.role === "agent" && entry.author === true);
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

export async function listAuthorNeeded(filePath: string): Promise<AuthorNeededItem[]> {
  return collectAuthorNeeded(await loadSidecar(filePath));
}

export interface AuthorReplyResult {
  via: "server" | "sidecar";
  commentId: string;
}

function startupPath(filePath: string): string {
  return path.join(path.dirname(filePath), ".review", path.basename(filePath) + ".startup.json");
}

function readStartup(filePath: string): { url?: string; csrf_token?: string } | null {
  const sp = startupPath(filePath);
  if (!existsSync(sp)) return null;
  try {
    return JSON.parse(readFileSync(sp, "utf-8")) as { url?: string; csrf_token?: string };
  } catch {
    return null;
  }
}

async function postToLiveServer(
  filePath: string,
  commentId: string,
  message: string,
  name: string,
): Promise<boolean> {
  const startup = readStartup(filePath);
  if (!startup?.url || !startup.csrf_token) return false;
  try {
    const res = await fetch(`${startup.url}/api/comment/${encodeURIComponent(commentId)}/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Redline-Token": startup.csrf_token,
      },
      body: JSON.stringify({ role: "agent", name, message, author: true }),
    });
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
  options: { name?: string } = {},
): Promise<AuthorReplyResult> {
  const trimmed = message.trim();
  if (!trimmed) throw new Error("message is required");
  const name = options.name?.trim() || "Author";

  if (await postToLiveServer(filePath, commentId, trimmed, name)) {
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
    });
    return { ok: true as const };
  });
  if (!result.ok) throw new Error(`Comment not found: ${commentId}`);
  return { via: "sidecar", commentId };
}

export function formatAuthorNeeded(items: AuthorNeededItem[]): string {
  if (items.length === 0) return "No author replies needed.";
  const lines = [
    `${items.length} comment${items.length === 1 ? " needs an author reply" : "s need author replies"}:`,
  ];
  for (const item of items) {
    lines.push(`- ${item.commentId} (round ${item.round}${item.resolved ? ", resolved" : ", open"}): "${item.quote}"`);
    if (item.request) lines.push(`  Reviewer: ${item.request}`);
    if (item.note) lines.push(`  Inline agent: ${item.note}`);
  }
  return lines.join("\n");
}
