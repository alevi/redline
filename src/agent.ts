import path from "path";
import { existsSync, unlinkSync } from "fs";
import { appendFile, mkdir, readFile } from "fs/promises";
import { resolve } from "./resolve";
import { pickReplyModel } from "./pickModel";
import { parseReply } from "./parseReply";
import { newEnvelope } from "./promptEnvelope";
import { contextBlock } from "./contextBlock";
import { loadSidecar } from "./sidecar";
import { getAgentProvider, resolveProviderId } from "./agentProvider";

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

// Test-only "always crash" hook: every spawn exits non-zero after a short
// delay, so the cli's restart cap can be exercised end-to-end. Unlike the
// crash-file hook above, this leaves no trigger to delete — every spawn
// crashes until the cli gives up.
if (process.env.REDLINE_AGENT_CRASH_ALWAYS === "1") {
  setTimeout(() => {
    console.log("[agent] crash-always hook fired — exiting");
    process.exit(99);
  }, 100);
}

const BASE_URL = `http://localhost:${process.env.REDLINE_PORT ?? "3000"}`;
const CSRF_TOKEN = process.env.REDLINE_TOKEN ?? "";
const provider = getAgentProvider(resolveProviderId());

// Inject `X-Redline-Token` on every mutating call back to the server. The
// server rejects unauthenticated POST/DELETE/PUT/PATCH on /api/*; without
// this header the agent's replies would be silently 403'd.
const CSRF_HEADER = { "X-Redline-Token": CSRF_TOKEN };

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

function replySystemPrompt(envelopeHint: string): string {
  return REPLY_SYSTEM_PROMPT_BODY + "\n\n" + envelopeHint;
}

const REPLY_SYSTEM_PROMPT_BODY =
  "You are an AI writing assistant responding to inline review comments on a Markdown document. " +
  "The reviewer has selected a passage and left a comment or question. Reply in the cards rail — keep it tight.\n" +
  "- Match reply length to the reviewer's comment. A one-line comment gets a one-line reply. A typo flag gets \"Got it\" or similar.\n" +
  "- Only propose replacement text or alternatives when the reviewer explicitly asks for them. Don't volunteer options they didn't request.\n" +
  "- If the reviewer asks a question, answer it directly. If they approve something, a short confirmation is enough.\n" +
  "- Never recap what they said back to them. No preamble. Start with the substance.\n" +
  "- Hard ceiling: 3 sentences unless the reviewer's comment genuinely requires more.\n" +
  "\n" +
  "After your reply, decide: would fully addressing this comment require editing the document itself, or was it answered within the conversation?\n" +
  "- requires_revision: true  → an edit to the doc is implied (typo fix, rewording, restructure, content change, etc.)\n" +
  "- requires_revision: false → the conversation answered it (clarifying question, approval, agent explanation that doesn't imply an edit)\n" +
  "\n" +
  "When requires_revision is true, the UI already shows the reason next to your reply — DO NOT restate the planned edit in your message. The message should engage with the reviewer (acknowledge, confirm, or briefly engage with their point); the reason describes the edit. Don't say the same thing twice.\n" +
  "Bad:  message: \"Will add a line 3 to the example.\"  reason: \"Add a third line to the hard line breaks example\"  ← redundant\n" +
  "Good: message: \"Got it.\"  reason: \"Add a third line to the hard line breaks example\"\n" +
  "When requires_revision is false, leave reason empty (or a very short note about why no edit). The reply IS the answer.\n" +
  "\n" +
  "Separately, decide whether this comment needs an AUTHOR reply from the agent that launched/wrote this document rather than you. ESCALATE is rare for now: set ESCALATE: true only when the reviewer explicitly asks for information, tools, authority, or project context you cannot access from the document and comment thread — for example an external style guide, a hidden spec, repo-wide code context, or a decision the authoring agent must make. Do NOT route ordinary requested edits, reframes, emphasis changes, priority changes, rewrites, or approvals; those are handled by requires_revision. If the comment can be satisfied by editing this document, set ESCALATE: false. When you do route to the author, briefly tell the reviewer that an author reply is needed. Author handoff does not change requires_revision — judge that on its own.\n" +
  "\n" +
  "Output exactly this format and nothing else (no prose before/after, no code fences). Use these literal markers — do not escape quotes inside the message:\n" +
  "REQUIRES_REVISION: <true|false>\n" +
  "ESCALATE: <true|false>\n" +
  "REASON: <one short sentence describing the edit, or empty>\n" +
  "---MESSAGE---\n" +
  "<your reply text — quotes, punctuation, anything>\n" +
  "---END---";

const inProgress = new Set<string>();

async function fetchComments() {
  const res = await fetch(`${BASE_URL}/api/comments`);
  return res.json() as Promise<{ comments: any[]; roundResolved: boolean }>;
}

async function postThinking(commentId: string) {
  await fetch(`${BASE_URL}/api/comment/${commentId}/thinking`, {
    method: "POST",
    headers: CSRF_HEADER,
  });
}

async function postReply(
  commentId: string,
  message: string,
  requires_revision: boolean,
  revision_reason: string,
  escalate: boolean
) {
  await fetch(`${BASE_URL}/api/comment/${commentId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...CSRF_HEADER },
    body: JSON.stringify({ role: "agent", name: provider.displayName, message, requires_revision, revision_reason, escalate }),
  });
}

async function postAgentReplied() {
  await fetch(`${BASE_URL}/api/agent-replied`, {
    method: "POST",
    headers: CSRF_HEADER,
  });
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
    const sidecar = await loadSidecar(path.resolve(filePath));
    const env = newEnvelope();
    const threadText = thread
      .map((e: any) => `${e.role === "human" ? "Reviewer" : "Agent"}: ${e.message}`)
      .join("\n");

    // Wrap every user-controlled string (document, quote, thread, optional
    // reviewer-supplied context) in a per-prompt UUID-anchored envelope so
    // adversarial content inside any of them can't masquerade as system
    // instructions or as another section. The context block is empty when
    // the user didn't pass --context.
    const userMessage =
      contextBlock(sidecar.context, env) +
      `## Document\n\n${env.wrap("document", docText)}\n\n---\n\n` +
      `## Comment\n\nQuoted passage:\n${env.wrap("quote", comment.quote)}\n\n` +
      `Thread:\n${env.wrap("thread", threadText)}`;

    const lastMessage = thread[thread.length - 1].message as string;
    const tier = pickReplyModel(lastMessage);
    const model = provider.modelForTier(tier);
    console.log(`[agent] replying to ${commentId} with ${provider.id}/${model}`);

    const reply = await provider.runReply({
      systemPrompt: replySystemPrompt(env.systemPromptHint()),
      userMessage,
      model,
      cwd: process.cwd(),
    });

    if (reply.trim()) {
      const parsed = parseReply(reply);
      console.log(`[agent] verdict for ${commentId}: requires_revision=${parsed.requires_revision} escalate=${parsed.escalate}`);
      await postReply(commentId, parsed.message, parsed.requires_revision, parsed.reason, parsed.escalate);
    }
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
        headers: { "Content-Type": "application/json", ...CSRF_HEADER },
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
