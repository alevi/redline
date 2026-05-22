import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "fs";
import path from "path";
import os from "os";
import {
  loadSidecar,
  saveSidecar,
  activeRound,
  getOrCreateActiveRound,
  withSidecar,
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
                {
                  role: "human",
                  message: "swap this",
                  at: "2026-04-29T10:05:00Z",
                },
                {
                  role: "agent",
                  name: "Claude",
                  message: "ok",
                  at: "2026-04-29T10:06:00Z",
                },
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
        {
          round: 1,
          started_at: "",
          submitted_at: null,
          agent_replied_at: null,
          resolved_at: "x",
          comments: [],
        },
        {
          round: 2,
          started_at: "",
          submitted_at: null,
          agent_replied_at: null,
          resolved_at: null,
          comments: [],
        },
      ],
    };
    expect(activeRound(s)?.round).toBe(2);
  });

  test("returns null when every round is resolved", () => {
    const s: Sidecar = {
      file: "doc.md",
      rounds: [
        {
          round: 1,
          started_at: "",
          submitted_at: null,
          agent_replied_at: null,
          resolved_at: "x",
          comments: [],
        },
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
        {
          round: 1,
          started_at: "",
          submitted_at: null,
          agent_replied_at: null,
          resolved_at: null,
          comments: [],
        },
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
        {
          round: 1,
          started_at: "",
          submitted_at: null,
          agent_replied_at: null,
          resolved_at: "x",
          comments: [],
        },
        {
          round: 2,
          started_at: "",
          submitted_at: null,
          agent_replied_at: null,
          resolved_at: "x",
          comments: [],
        },
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

describe("withSidecar — concurrency", () => {
  test("intra-process: 50 parallel mutations all land", async () => {
    // Even before the file lock, the in-memory queue serialized intra-
    // process calls; this is the regression guard.
    const promises = [];
    for (let i = 0; i < 50; i++) {
      promises.push(
        withSidecar(docPath, (s) => {
          const r = getOrCreateActiveRound(s);
          r.comments.push({
            id: `c${i}`,
            quote: "x",
            context_before: "",
            context_after: "",
            thread: [],
            resolved: false,
          });
        }),
      );
    }
    await Promise.all(promises);
    const final = await loadSidecar(docPath);
    expect(final.rounds[0].comments.length).toBe(50);
  });

  test("cross-process: two redline-shaped processes don't trample each other's writes", async () => {
    // Spawn two Bun processes that each append 25 comments to the same
    // sidecar concurrently. Without a file lock, ~half the writes get
    // dropped because each process's load → mutate → save cycle reads
    // a stale view of the other's last save.
    const fixture = path.resolve(
      import.meta.dir,
      "..",
      "tests",
      "fixtures",
      "sidecar-writer.ts",
    );
    const a = Bun.spawn(
      [process.execPath, "run", fixture, docPath, "A", "25"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const b = Bun.spawn(
      [process.execPath, "run", fixture, docPath, "B", "25"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [aCode, bCode] = await Promise.all([a.exited, b.exited]);
    expect(aCode).toBe(0);
    expect(bCode).toBe(0);

    const final = await loadSidecar(docPath);
    expect(final.rounds.length).toBe(1);
    expect(final.rounds[0].comments.length).toBe(50);

    // Every ID from both writers is present (proves no write was dropped).
    const ids = new Set(final.rounds[0].comments.map((c) => c.id));
    for (let i = 0; i < 25; i++) {
      expect(ids.has(`A-${i}`)).toBe(true);
      expect(ids.has(`B-${i}`)).toBe(true);
    }
  }, 30_000);
});
