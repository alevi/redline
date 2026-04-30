import path from "path";
import { resolve } from "./resolve";
import { pickReplyModel } from "./pickModel";

const filePath = process.argv[2];
if (!filePath) {
  console.error("[agent] Usage: agent <file.md>");
  process.exit(1);
}

const BASE_URL = "http://localhost:3000";

const REPLY_SYSTEM_PROMPT =
  "You are an AI writing assistant responding to inline review comments on a Markdown document. " +
  "The reviewer has selected a passage and left a comment or question. Respond helpfully and concisely.\n" +
  "- If the reviewer asks for a change or alternative, suggest specific replacement text.\n" +
  "- If the reviewer asks a question, answer it directly.\n" +
  "- If the reviewer approves something, confirm and note what you'll update in the revision.\n" +
  "- Keep responses to 1–3 sentences unless depth is genuinely needed.\n" +
  "- Do not add preamble. Start with the substance.";

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

    const threadText = thread
      .map((e: any) => `${e.role === "human" ? "Reviewer" : "Agent"}: ${e.message}`)
      .join("\n");

    const userMessage =
      `Quoted passage: "${comment.quote}"\n` +
      `Context before: "${comment.context_before}"\n` +
      `Context after: "${comment.context_after}"\n\n` +
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
  } finally {
    inProgress.delete(commentId);
    if (inProgress.size === 0) await postAgentReplied();
  }
}

async function handleAccepted() {
  console.log("[agent] accepted — running revision...");
  await resolve(path.resolve(filePath));
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
