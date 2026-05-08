import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import path from "path";
import os from "os";
import {
  loadSidecar,
  saveSidecar,
  activeRound,
  getOrCreateActiveRound,
  type Sidecar,
} from "./sidecar";

let tmpDir: string;
let docPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "redline-sidecar-"));
  docPath = path.join(tmpDir, "doc.md");
  writeFileSync(docPath, "# hello\n");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadSidecar", () => {
  test("returns an empty sidecar when no file exists", async () => {
    const s = await loadSidecar(docPath);
    expect(s.file).toBe("doc.md");
    expect(s.rounds).toEqual([]);
  });

  test("does not create the .review directory just by reading", async () => {
    await loadSidecar(docPath);
    expect(existsSync(path.join(tmpDir, ".review"))).toBe(false);
  });
});

describe("saveSidecar", () => {
  test("writes to .review/<filename>.json next to the doc", async () => {
    const s: Sidecar = { file: "doc.md", rounds: [] };
    await saveSidecar(docPath, s);
    expect(existsSync(path.join(tmpDir, ".review", "doc.md.json"))).toBe(true);
  });

  test("round-trips a sidecar with rounds, comments, and threads", async () => {
    const s: Sidecar = {
      file: "doc.md",
      rounds: [
        {
          round: 1,
          started_at: "2026-04-29T10:00:00Z",
          submitted_at: null,
          agent_replied_at: null,
          resolved_at: "2026-04-29T11:00:00Z",
          comments: [
            {
              id: "c1",
              quote: "trowel",
              context_before: "A small ",
              context_after: " (ceremonial)",
              thread: [
                { role: "human", message: "swap this", at: "2026-04-29T10:05:00Z" },
                { role: "agent", name: "Claude", message: "ok", at: "2026-04-29T10:06:00Z" },
              ],
              resolved: true,
            },
          ],
        },
      ],
    };
    await saveSidecar(docPath, s);
    const loaded = await loadSidecar(docPath);
    expect(loaded).toEqual(s);
  });
});

describe("activeRound", () => {
  test("returns the round with resolved_at === null", () => {
    const s: Sidecar = {
      file: "doc.md",
      rounds: [
        { round: 1, started_at: "", submitted_at: null, agent_replied_at: null, resolved_at: "x", comments: [] },
        { round: 2, started_at: "", submitted_at: null, agent_replied_at: null, resolved_at: null, comments: [] },
      ],
    };
    expect(activeRound(s)?.round).toBe(2);
  });

  test("returns null when every round is resolved", () => {
    const s: Sidecar = {
      file: "doc.md",
      rounds: [
        { round: 1, started_at: "", submitted_at: null, agent_replied_at: null, resolved_at: "x", comments: [] },
      ],
    };
    expect(activeRound(s)).toBeNull();
  });
});

describe("getOrCreateActiveRound", () => {
  test("returns the existing active round when one exists", () => {
    const s: Sidecar = {
      file: "doc.md",
      rounds: [
        { round: 1, started_at: "", submitted_at: null, agent_replied_at: null, resolved_at: null, comments: [] },
      ],
    };
    const r = getOrCreateActiveRound(s);
    expect(r.round).toBe(1);
    expect(s.rounds.length).toBe(1);
  });

  test("creates a new round numbered N+1 when all rounds are resolved", () => {
    const s: Sidecar = {
      file: "doc.md",
      rounds: [
        { round: 1, started_at: "", submitted_at: null, agent_replied_at: null, resolved_at: "x", comments: [] },
        { round: 2, started_at: "", submitted_at: null, agent_replied_at: null, resolved_at: "x", comments: [] },
      ],
    };
    const r = getOrCreateActiveRound(s);
    expect(r.round).toBe(3);
    expect(r.resolved_at).toBeNull();
    expect(s.rounds.length).toBe(3);
  });

  test("creates round 1 from an empty sidecar", () => {
    const s: Sidecar = { file: "doc.md", rounds: [] };
    const r = getOrCreateActiveRound(s);
    expect(r.round).toBe(1);
    expect(s.rounds.length).toBe(1);
  });
});
