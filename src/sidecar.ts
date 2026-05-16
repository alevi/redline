import { readFile, writeFile, mkdir } from "fs/promises";
import { closeSync, existsSync, openSync } from "fs";
import path from "path";
import lockfile from "proper-lockfile";

export interface ThreadEntry {
  role: "human" | "agent";
  name?: string;
  message: string;
  at: string;
  // Agent replies carry a verdict on whether the comment, once resolved,
  // implies an edit to the document. Used to decide whether the round-level
  // action defaults to "Revise" or "Accept as-is". Only set on agent entries.
  requires_revision?: boolean;
  revision_reason?: string;
  // Set true on an agent reply when the comment can't be acted on from inside
  // this review — it needs author-level context, tools, or authority the inline
  // agent lacks. Surfaced in the closeout summary so the authoring agent picks
  // it up. Only set on agent entries.
  escalate?: boolean;
}

// Latest agent verdict on a comment thread:
// - 'revise'  → an agent reply set requires_revision: true
// - 'accept'  → an agent reply set requires_revision: false
// - null      → no agent reply yet (treat as accept per UX spec; the human
//               resolved unilaterally so they're saying "doesn't matter")
export function latestVerdict(comment: Comment): "revise" | "accept" | null {
  for (let i = comment.thread.length - 1; i >= 0; i--) {
    const e = comment.thread[i];
    if (e.role !== "agent") continue;
    if (typeof e.requires_revision !== "boolean") continue;
    return e.requires_revision ? "revise" : "accept";
  }
  return null;
}

export interface Comment {
  id: string;
  quote: string;
  context_before: string;
  context_after: string;
  thread: ThreadEntry[];
  resolved: boolean;
}

export interface Round {
  round: number;
  started_at: string;
  submitted_at: string | null;    // human clicked "Submit for review" — agent should respond
  agent_replied_at: string | null; // agent posted replies — human should review
  resolved_at: string | null;     // human accepted — agent should revise the document
  comments: Comment[];
}

export interface Sidecar {
  file: string;
  context?: string;
  rounds: Round[];
}

function sidecarPath(filePath: string): string {
  const dir = path.join(path.dirname(filePath), ".review");
  const base = path.basename(filePath) + ".json";
  return path.join(dir, base);
}

export async function loadSidecar(filePath: string): Promise<Sidecar> {
  const sp = sidecarPath(filePath);
  if (existsSync(sp)) {
    const raw = await readFile(sp, "utf-8");
    // withSidecar may touch an empty sidecar file before the first save
    // (lockfile needs a target that exists); treat that as the empty shape.
    if (raw.trim() === "") {
      return { file: path.basename(filePath), rounds: [] };
    }
    return JSON.parse(raw) as Sidecar;
  }
  return {
    file: path.basename(filePath),
    rounds: [],
  };
}

export async function saveSidecar(
  filePath: string,
  sidecar: Sidecar
): Promise<void> {
  const sp = sidecarPath(filePath);
  await mkdir(path.dirname(sp), { recursive: true });
  await writeFile(sp, JSON.stringify(sidecar, null, 2), "utf-8");
}

// Two layers of mutex around the load → mutate → save cycle:
//
// 1. Per-process queue (in-memory) — fast path that serializes calls inside
//    one redline process. The previous version used only this; two POSTs
//    against the same file would interleave their load/save pair without it.
//
// 2. Per-file lock (proper-lockfile, on `<sidecar>.lock`) — slow path that
//    serializes calls across processes. Without this, two `redline` instances
//    on the same file (two terminals, a forgotten background instance, a
//    skill invocation while a manual run is open) silently trample each
//    other's writes. The in-memory queue inside each process never sees the
//    other process exists.
//
// Layering matters: every transaction acquires the file lock, but only one
// in-flight per process competes for it. Without the in-memory queue, a
// flurry of POSTs in one process would all contend on the file lock and
// serialize through filesystem operations (slow, can stall on macOS).
const sidecarLocks = new Map<string, Promise<unknown>>();

function lockTargetFor(filePath: string): string {
  // proper-lockfile creates `<file>.lock` next to the target. We lock the
  // sidecar JSON itself, not the doc, since the sidecar is the contended
  // resource. proper-lockfile requires the target to exist; touch it if
  // it's the first transaction on a brand-new file.
  return sidecarPath(filePath);
}

async function ensureLockTarget(filePath: string): Promise<string> {
  const sp = lockTargetFor(filePath);
  await mkdir(path.dirname(sp), { recursive: true });
  if (!existsSync(sp)) {
    // Touch — empty file is fine, loadSidecar treats missing-or-empty alike.
    closeSync(openSync(sp, "a"));
  }
  return sp;
}

/**
 * Run `fn` against the sidecar with a per-file mutex held across the
 * load → mutate → save cycle. The mutator may return a value (passed through
 * to the caller) and/or `false` to skip the save (e.g. when validation fails
 * before any mutation happened — avoids a redundant disk write).
 *
 * Lock scope spans both processes (file lock) and intra-process callers
 * (in-memory queue), so concurrent redline instances on the same file
 * serialize correctly.
 */
export async function withSidecar<T>(
  filePath: string,
  fn: (sidecar: Sidecar) => T | Promise<T>
): Promise<T> {
  const key = path.resolve(filePath);
  const prev = sidecarLocks.get(key) ?? Promise.resolve();
  const next = prev.then(async () => {
    const lockTarget = await ensureLockTarget(filePath);
    // retries.forever: true is a deliberate choice — withSidecar callers
    // expect to succeed eventually. Inter-process contention should be rare
    // (two redline instances on the same file is itself unusual); when it
    // happens, waiting is the right behavior, not failing.
    const release = await lockfile.lock(lockTarget, {
      retries: { retries: 30, factor: 1.5, minTimeout: 50, maxTimeout: 1000 },
      stale: 30_000, // a process holding the lock >30s is presumed dead
    });
    try {
      const sidecar = await loadSidecar(filePath);
      const result = await fn(sidecar);
      // Skip the save if the mutator explicitly returned false. Useful for
      // validate-only paths that bail before mutating; keeps the lock scope
      // honest (we still serialized) without the wasted write.
      if ((result as unknown) !== false) {
        await saveSidecar(filePath, sidecar);
      }
      return result;
    } finally {
      await release().catch(() => {});
    }
  });
  // Catch errors so one failed mutator doesn't poison the queue for the next
  // caller. The original `next` promise still rejects for the current caller.
  sidecarLocks.set(key, next.catch(() => {}));
  return next;
}

export function activeRound(sidecar: Sidecar): Round | null {
  return sidecar.rounds.find((r) => r.resolved_at === null) ?? null;
}

export function getOrCreateActiveRound(sidecar: Sidecar): Round {
  const existing = activeRound(sidecar);
  if (existing) return existing;

  const round: Round = {
    round: sidecar.rounds.length + 1,
    started_at: new Date().toISOString(),
    submitted_at: null,
    agent_replied_at: null,
    resolved_at: null,
    comments: [],
  };
  sidecar.rounds.push(round);
  return round;
}
