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
