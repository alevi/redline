import { afterEach, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { collectAuthorNeeded, formatAuthorNeeded, postAuthorReply, waitForAuthorEvent } from "../src/authorHandoff";
import { saveSidecar, type Sidecar } from "../src/sidecar";
import { BUN, CLI, createTestFile, postComment, spawnCLI, TEST_ENV } from "./helpers";

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function sidecar(): Sidecar {
  return {
    file: "test.md",
    rounds: [
      {
        round: 1,
        started_at: "",
        submitted_at: null,
        agent_replied_at: null,
        resolved_at: null,
        comments: [
          {
            id: "c1",
            quote: "the style note",
            context_before: "",
            context_after: "",
            resolved: false,
            thread: [
              { role: "human", message: "Can you check the house style guide?", at: "" },
              {
                role: "agent",
                name: "Claude",
                message: "I cannot see it, so an author reply is needed.",
                at: "",
                escalate: true,
              },
            ],
          },
          {
            id: "c2",
            quote: "already answered",
            context_before: "",
            context_after: "",
            resolved: true,
            thread: [
              { role: "human", message: "Ask the author.", at: "" },
              { role: "agent", message: "Author reply needed.", at: "", escalate: true },
              { role: "agent", name: "Author", message: "We use sentence case here.", at: "", author: true },
            ],
          },
        ],
      },
    ],
  };
}

test("collectAuthorNeeded returns escalated comments that do not yet have an author reply", () => {
  const items = collectAuthorNeeded(sidecar());

  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    round: 1,
    commentId: "c1",
    quote: "the style note",
    request: "Can you check the house style guide?",
    note: "I cannot see it, so an author reply is needed.",
    resolved: false,
  });
});

test("collectAuthorNeeded reopens a handoff if a later escalation follows an author reply", () => {
  const s = sidecar();
  s.rounds[0]!.comments[1]!.thread.push(
    { role: "human", message: "What about the migration appendix?", at: "" },
    { role: "agent", message: "That needs the author too.", at: "", escalate: true },
  );

  const items = collectAuthorNeeded(s);
  expect(items.map((item) => item.commentId)).toEqual(["c1", "c2"]);
  expect(items[1]!.request).toBe("What about the migration appendix?");
});

test("postAuthorReply falls back to a locked sidecar write when no server is running", async () => {
  const { filePath, dir } = createTestFile();
  await saveSidecar(filePath, sidecar());

  const result = await postAuthorReply(filePath, "c1", "Use sentence case here.", { name: "Codex" });

  expect(result).toEqual({ via: "sidecar", commentId: "c1" });
  const saved = JSON.parse(await readFile(path.join(dir, ".review", "test.md.json"), "utf-8")) as Sidecar;
  const entry = saved.rounds[0]!.comments[0]!.thread.at(-1)!;
  expect(entry).toMatchObject({
    role: "agent",
    name: "Codex",
    message: "Use sentence case here.",
    author: true,
  });
  expect(collectAuthorNeeded(saved)).toHaveLength(0);
});

test("formatAuthorNeeded gives a compact command-line summary", () => {
  const out = formatAuthorNeeded(collectAuthorNeeded(sidecar()));

  expect(out).toContain("1 comment needs an author reply");
  expect(out).toContain("c1 (round 1, open)");
  expect(out).toContain("Reviewer: Can you check the house style guide?");
  expect(formatAuthorNeeded([])).toBe("No author replies needed.");
});

test("CLI author-needed and author-reply expose the author handoff loop", async () => {
  const { filePath, dir } = createTestFile();
  await saveSidecar(filePath, sidecar());

  const pending = spawnSync(BUN, ["run", CLI, "author-needed", filePath, "--json"], {
    env: TEST_ENV,
    encoding: "utf-8",
  });
  expect(pending.status).toBe(0);
  const parsed = JSON.parse(pending.stdout);
  expect(parsed.author_needed).toHaveLength(1);
  expect(parsed.author_needed[0].commentId).toBe("c1");

  const reply = spawnSync(BUN, ["run", CLI, "author-reply", filePath, "c1", "--message", "Use sentence case."], {
    env: TEST_ENV,
    encoding: "utf-8",
  });
  expect(reply.status).toBe(0);
  expect(reply.stdout).toContain("Posted author reply to c1");

  const saved = JSON.parse(await readFile(path.join(dir, ".review", "test.md.json"), "utf-8")) as Sidecar;
  expect(saved.rounds[0]!.comments[0]!.thread.at(-1)).toMatchObject({
    name: "Author",
    author: true,
    message: "Use sentence case.",
  });
}, 20_000);

test("CLI author-reply uses the live server when startup metadata is present", async () => {
  const { filePath, dir } = createTestFile();
  const { proc, port } = await spawnCLI(filePath, {}, ["--no-agent"]);
  stops.push(() => { try { proc.kill(); } catch {} });

  const c = await postComment(port, { quote: "test" }, "Check the private style guide.");
  await fetch(`http://localhost:${port}/api/comment/${c.id}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Redline-Token": TEST_ENV.REDLINE_TOKEN! },
    body: JSON.stringify({
      role: "agent",
      name: "Claude",
      message: "I cannot see it, so an author reply is needed.",
      escalate: true,
    }),
  });

  const reply = spawnSync(BUN, ["run", CLI, "author-reply", filePath, c.id, "--message", "Use sentence case."], {
    env: TEST_ENV,
    encoding: "utf-8",
  });
  expect(reply.status).toBe(0);
  expect(reply.stdout).toContain(`Posted author reply to ${c.id} via server.`);

  const saved = JSON.parse(await readFile(path.join(dir, ".review", "test.md.json"), "utf-8")) as Sidecar;
  expect(saved.rounds[0]!.comments[0]!.thread.at(-1)).toMatchObject({
    name: "Author",
    author: true,
    message: "Use sentence case.",
  });
}, 20_000);

test("waitForAuthorEvent returns pending author-needed comments before result", async () => {
  const { filePath } = createTestFile();
  await saveSidecar(filePath, sidecar());

  const result = await waitForAuthorEvent(filePath, { intervalMs: 50, timeoutMs: 500 });

  expect(result.kind).toBe("author-needed");
  if (result.kind === "author-needed") {
    expect(result.author_needed).toHaveLength(1);
    expect(result.author_needed[0]!.commentId).toBe("c1");
  }
});

test("waitForAuthorEvent returns the review result when no author input is pending", async () => {
  const { filePath, dir } = createTestFile();
  const resultPath = path.join(dir, ".review", "test.md.result");
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, JSON.stringify({ status: "approved", file: filePath }), "utf-8");

  const result = await waitForAuthorEvent(filePath, { intervalMs: 50, timeoutMs: 500 });

  expect(result).toEqual({
    kind: "result",
    file: filePath,
    result: { status: "approved", file: filePath },
  });
});

test("waitForAuthorEvent times out when neither author input nor result appears", async () => {
  const { filePath } = createTestFile();

  await expect(waitForAuthorEvent(filePath, { intervalMs: 50, timeoutMs: 100 })).rejects.toThrow(/Timed out/);
});

test("waitForAuthorEvent reports session-ended when startup pid is gone and no result exists", async () => {
  const { filePath, dir } = createTestFile();
  const startupPath = path.join(dir, ".review", "test.md.startup.json");
  await mkdir(path.dirname(startupPath), { recursive: true });
  await writeFile(startupPath, JSON.stringify({ pid: 999_999_999, url: "http://localhost:9" }), "utf-8");

  const result = await waitForAuthorEvent(filePath, { intervalMs: 50, timeoutMs: 500 });

  expect(result).toEqual({
    kind: "session-ended",
    file: filePath,
    pid: 999_999_999,
    message: "Redline session process ended before writing a result.",
  });
});

test("CLI author-wait prints author-needed JSON", async () => {
  const { filePath } = createTestFile();
  await saveSidecar(filePath, sidecar());

  const wait = spawnSync(BUN, ["run", CLI, "author-wait", filePath, "--timeout-ms", "500", "--interval-ms", "50"], {
    env: TEST_ENV,
    encoding: "utf-8",
  });

  expect(wait.status).toBe(0);
  const parsed = JSON.parse(wait.stdout);
  expect(parsed.kind).toBe("author-needed");
  expect(parsed.author_needed[0].commentId).toBe("c1");
}, 20_000);

test("CLI author-wait prints result JSON", async () => {
  const { filePath, dir } = createTestFile();
  const resultPath = path.join(dir, ".review", "test.md.result");
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, JSON.stringify({ status: "approved", file: filePath }), "utf-8");

  const wait = spawnSync(BUN, ["run", CLI, "author-wait", filePath, "--timeout-ms", "500", "--interval-ms", "50"], {
    env: TEST_ENV,
    encoding: "utf-8",
  });

  expect(wait.status).toBe(0);
  const parsed = JSON.parse(wait.stdout);
  expect(parsed.kind).toBe("result");
  expect(parsed.result.status).toBe("approved");
}, 20_000);

test("CLI author-wait prints session-ended JSON", async () => {
  const { filePath, dir } = createTestFile();
  const startupPath = path.join(dir, ".review", "test.md.startup.json");
  await mkdir(path.dirname(startupPath), { recursive: true });
  await writeFile(startupPath, JSON.stringify({ pid: 999_999_999, url: "http://localhost:9" }), "utf-8");

  const wait = spawnSync(BUN, ["run", CLI, "author-wait", filePath, "--timeout-ms", "500", "--interval-ms", "50"], {
    env: TEST_ENV,
    encoding: "utf-8",
  });

  expect(wait.status).toBe(0);
  const parsed = JSON.parse(wait.stdout);
  expect(parsed.kind).toBe("session-ended");
  expect(parsed.pid).toBe(999_999_999);
}, 20_000);
