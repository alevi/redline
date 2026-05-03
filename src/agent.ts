import path from "path";
import { existsSync, unlinkSync } from "fs";
import { appendFile, mkdir, readFile } from "fs/promises";
import { resolve } from "./resolve";
import { pickReplyModel } from "./pickModel";

const filePath = process.argv[2];
if (!filePath) {
  console.error("[agent] Usage: agent <file.md>");
  process.exit(1);
}

// Test-only crash hook: shortly after startup, if REDLINE_AGENT_CRASH_FILE
// points to an existing file, delete it and exit non-zero. The delay is so
// the agent connects to SSE and logs "[agent] connected" first — the test
// then waits for a *second* connect to prove the restart fired. Unlink
// ensures the restart spawn starts cleanly.
const crashFile = process.env.REDLINE_AGENT_CRASH_FILE;
if (crashFile) {
  setTimeout(() => {
    if (!existsSync(crashFile)) return;
    console.log(`[agent] crash hook fired — exiting (file=${crashFile})`);
    try { unlinkSync(crashFile); } catch { /* best effort */ }
    process.exit(99);
  }, 500);
}

const BASE_URL = `http://localhost:${process.env.REDLINE_PORT ?? "3000"}`;

async function logReplyFailure(commentId: string, err: unknown) {
  const logDir = path.join(path.dirname(path.resolve(filePath)), ".review");
  await mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, "errors.log");
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? `\n${err.stack}` : "";
  const entry =
    `\n=== ${new Date().toISOString()} — reply failure — comment ${commentId} ===\n` +
    `file:    ${path.resolve(filePath)}\n` +
    `reason:  ${msg}${stack}\n` +
    `===\n`;
  try {
    await appendFile(logPath, entry, "utf-8");
    console.error(`[agent] Logged reply failure → .review/errors.log`);
  } catch {
    // best-effort — don't mask the original error
  }
}

const REPLY_SYSTEM_PROMPT =
  "You are an AI writing assistant responding to inline review comments on a Markdown document. " +
  "The reviewer has selected a passage and left a comment or question. Reply in the cards rail — keep it tight.\n" +
  "- Match reply length to the reviewer's comment. A one-line comment gets a one-line reply. A typo flag gets \"Got it\" or similar.\n" +
  "- Only propose replacement text or alternatives when the reviewer explicitly asks for them. Don't volunteer options they didn't request.\n" +
  "- If the reviewer asks a question, answer it directly. If they approve something, a short confirmation is enough.\n" +
  "- Never recap what they said back to them. No preamble. Start with the substance.\n" +
  "- Hard ceiling: 3 sentences unless the reviewer's comment genuinely requires more.";

const inProgress = new Set<string>();

async function fetchComments() {
  const res = await fetch(`${BASE_URL}/api/comments`);
  return res.json() as Promise<{ comments: any[]; roundResolved: boolean }>;
}

async function postThinking(commentId: string) {
  await fetch(`${BASE_URL}/api/comment/${commentId}/thinking`, { method: "POST" });
}

async function postReply(commentId: string, message: string) {
  await fetch(`${BASE_URL}/api/comment/${commentId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "agent", name: "Claude", message }),
  });
}

async function postAgentReplied() {
  await fetch(`${BASE_URL}/api/agent-replied`, { method: "POST" });
}

async function handleComment(commentId: string) {
  if (inProgress.has(commentId)) return;
  inProgress.add(commentId);

  try {
    const data = await fetchComments();
    const comment = data.comments.find((c: any) => c.id === commentId);
    if (!comment || comment.resolved) return;

    // Only respond when the last message was from the human
    const thread: any[] = comment.thread ?? [];
    if (thread.length === 0 || thread[thread.length - 1].role !== "human") return;

    await postThinking(commentId);

    const docText = await readFile(path.resolve(filePath), "utf-8");
    const threadText = thread
      .map((e: any) => `${e.role === "human" ? "Reviewer" : "Agent"}: ${e.message}`)
      .join("\n");

    const userMessage =
      `## Document\n\n${docText}\n\n---\n\n` +
      `## Comment\n\nQuoted passage: "${comment.quote}"\n\n` +
      `Thread:\n${threadText}`;

    const lastMessage = thread[thread.length - 1].message as string;
    const model = pickReplyModel(lastMessage);
    console.log(`[agent] replying to ${commentId} with ${model}`);

    const cliBin = process.env.CLAUDE_CODE_EXECPATH ?? "claude";
    const proc = Bun.spawn(
      [cliBin, "-p", "--system-prompt", REPLY_SYSTEM_PROMPT, "--model", model],
      { stdin: "pipe", stdout: "pipe", stderr: "inherit" }
    );
    proc.stdin.write(userMessage);
    proc.stdin.end();

    let reply = "";
    const reader = proc.stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      reply += new TextDecoder().decode(value);
    }

    const trimmed = reply.trim();
    if (trimmed) await postReply(commentId, trimmed);
  } catch (err) {
    await logReplyFailure(commentId, err);
    throw err;
  } finally {
    inProgress.delete(commentId);
    if (inProgress.size === 0) {
      postAgentReplied().catch((e) => console.error("[agent] postAgentReplied failed:", e));
    }
  }
}

async function handleAccepted() {
  console.log("[agent] accepted — running revision...");
  try {
    await resolve(path.resolve(filePath));
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error("[agent] revision failed:", msg);
    try {
      await fetch(`${BASE_URL}/api/revision-error`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
    } catch { /* server may be down — non-fatal */ }
  }
}

async function handleEvent(type: string, payload: any) {
  if (type === "comment-added" || type === "comment-reply") {
    handleComment(payload.commentId).catch((e) =>
      console.error("[agent] error handling comment:", e)
    );
  } else if (type === "accepted") {
    handleAccepted().catch((e) =>
      console.error("[agent] error handling accepted:", e)
    );
  } else if (type === "finished") {
    console.log("[agent] review finished — no revision needed");
  }
}

async function connect() {
  let retryDelay = 1000;

  while (true) {
    try {
      const res = await fetch(`${BASE_URL}/api/events`);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      console.log("[agent] connected — listening for comments");
      retryDelay = 1000;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventType = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            try {
              const payload = JSON.parse(data);
              handleEvent(eventType, payload).catch((e) =>
                console.error("[agent] unhandled event error:", e)
              );
            } catch {}
            eventType = "";
          } else if (line === "") {
            eventType = "";
          }
        }
      }
    } catch {
      // server not up yet or restarting — keep retrying
    }

    await new Promise((r) => setTimeout(r, retryDelay));
    retryDelay = Math.min(retryDelay * 2, 10000);
  }
}

connect();
