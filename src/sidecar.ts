import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

export interface ThreadEntry {
  role: "human" | "agent";
  name?: string;
  message: string;
  at: string;
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

// Per-file mutex queue. Each entry is the tail of an in-flight chain; new
// transactions chain onto it so load → mutate → save is atomic against other
// transactions on the same file. Without this, two POSTs can interleave their
// load/save pair and silently drop one writer's mutation.
const sidecarLocks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` against the sidecar with a per-file mutex held across the
 * load → mutate → save cycle. The mutator may return a value (passed through
 * to the caller) and/or `false` to skip the save (e.g. when validation fails
 * before any mutation happened — avoids a redundant disk write).
 */
export async function withSidecar<T>(
  filePath: string,
  fn: (sidecar: Sidecar) => T | Promise<T>
): Promise<T> {
  const key = path.resolve(filePath);
  const prev = sidecarLocks.get(key) ?? Promise.resolve();
  const next = prev.then(async () => {
    const sidecar = await loadSidecar(filePath);
    const result = await fn(sidecar);
    // Skip the save if the mutator explicitly returned false. Useful for
    // validate-only paths that bail before mutating; keeps the lock scope
    // honest (we still serialized) without the wasted write.
    if ((result as unknown) !== false) {
      await saveSidecar(filePath, sidecar);
    }
    return result;
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
