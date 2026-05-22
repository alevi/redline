import { appendFile, copyFile, mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { loadSidecar, saveSidecar } from "./sidecar";
import type { Round, Comment } from "./sidecar";
import { pickRevisionModel } from "./pickModel";
import { newEnvelope } from "./promptEnvelope";
import { contextBlock } from "./contextBlock";
import {
  getAgentProvider,
  resolveProviderId,
  type AgentProviderId,
} from "./agentProvider";

const serverBase = () =>
  `http://localhost:${process.env.REDLINE_PORT ?? "3000"}`;
const csrfHeader = (): Record<string, string> => ({
  "X-Redline-Token": process.env.REDLINE_TOKEN ?? "",
});

export async function resolve(
  filePath: string,
  options: { model?: string; agentProvider?: AgentProviderId } = {},
) {
  const provider = getAgentProvider(
    options.agentProvider ?? resolveProviderId(),
  );
  const model = options.model ?? null;
  const sidecar = await loadSidecar(filePath);

  // Find the most recently accepted round
  const resolvedRounds = sidecar.rounds.filter((r) => r.resolved_at != null);
  if (resolvedRounds.length === 0) {
    throw new Error(
      "No accepted round found — human must click 'Accept & revise' first",
    );
  }
  const round: Round = resolvedRounds[resolvedRounds.length - 1];
  const settled = round.comments.filter((c) => c.resolved);
  const chosenModel =
    model ?? provider.modelForTier(pickRevisionModel(settled));

  const docText = await readFile(filePath, "utf-8");

  // Save history snapshot before any changes
  const historyDir = path.join(path.dirname(filePath), ".review", "history");
  await mkdir(historyDir, { recursive: true });
  const snapTs = new Date().toISOString();
  const snapFile = path.join(
    historyDir,
    `${path.basename(filePath)}.${snapTs}.md`,
  );
  await copyFile(filePath, snapFile);
  console.log(`Saved snapshot → .review/history/${path.basename(snapFile)}\n`);

  if (settled.length === 0) {
    console.log("No settled comments — no revision needed.");
    await openNextRound(sidecar, filePath);
    try {
      await fetch(`${serverBase()}/api/reload`, {
        method: "POST",
        headers: csrfHeader(),
      });
    } catch {
      /* non-fatal */
    }
    return;
  }

  // Build prompt — wrap user-controlled strings (quote, discussion text, the
  // document body, prior-round agent replies that may echo user content) in a
  // per-prompt envelope so adversarial comment content can't masquerade as
  // system instructions or another section.
  const env = newEnvelope();
  const commentsBlock = settled
    .map((c, i) => {
      const discussion = c.thread
        .map(
          (e) =>
            `    ${e.role === "agent" ? "Agent" : "Reviewer"}: ${e.message}`,
        )
        .join("\n");
      return `${i + 1}. Quote:\n${env.wrap(`comment-${i}-quote`, c.quote)}\n   Discussion:\n${env.wrap(`comment-${i}-discussion`, discussion)}`;
    })
    .join("\n\n");

  // Summarise what was agreed in earlier rounds so the model doesn't undo them
  const priorRounds = resolvedRounds.slice(0, -1);
  let priorChangesBlock = "";
  if (priorRounds.length > 0) {
    const lines = priorRounds.flatMap((r) =>
      r.comments
        .filter((c) => c.resolved)
        .map((c) => {
          const lastAgent = [...c.thread]
            .reverse()
            .find((e) => e.role === "agent");
          return `- Round ${r.round}: ${env.wrap(`prior-${r.round}-quote`, c.quote)} → ${env.wrap(`prior-${r.round}-reply`, lastAgent?.message ?? "(resolved)")}`;
        }),
    );
    if (lines.length > 0) {
      priorChangesBlock = `\n\n<previously-agreed-changes>\n${lines.join("\n")}\n</previously-agreed-changes>`;
    }
  }

  const systemPrompt =
    "You are revising a Markdown document based on settled reviewer comments.\n" +
    "For each comment, edit the relevant passage in the document to reflect what was agreed.\n" +
    "Preserve all sections that have no comments exactly as they are.\n" +
    "Return ONLY the revised contents of <document> — the full Markdown document, nothing else.\n" +
    "Do NOT include the <document> tags themselves in your output.\n" +
    "Do NOT echo, summarize, or append any of the <comments-to-apply> or <previously-agreed-changes> content.\n" +
    "Do NOT add commentary, preamble, or meta-sections like 'Settled comments' or 'Changelog'.\n" +
    "The output should look like a clean revision of the original document — as if a human editor made the changes silently.\n" +
    "\n" +
    env.systemPromptHint();

  // Prepend the reviewer's stated focus when --context was set; the helper
  // returns empty otherwise. Goes before the comments so the model reads the
  // user's lens first and weights the revision accordingly.
  const userMessage =
    contextBlock(sidecar.context, env) +
    `<comments-to-apply>\n${commentsBlock}\n</comments-to-apply>${priorChangesBlock}\n\n<document>\n${env.wrap("document", docText)}\n</document>`;

  const broadcastChunk = (text: string, kind: "thinking" | "text") => {
    fetch(`${serverBase()}/api/revision-chunk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeader() },
      body: JSON.stringify({ text, kind }),
    }).catch(() => {});
  };

  // Per-attempt state, hoisted so fail() can report whatever the latest
  // attempt produced.
  let revised = "";
  let exitCode = 0;
  let stderrText = "";

  const fail = async (reason: string) => {
    await logRevisionFailure(filePath, {
      reason,
      model: `${provider.id}/${chosenModel}`,
      exitCode,
      stderr: stderrText.trim(),
      stdoutSample: revised.slice(0, 2000),
      stdoutLength: revised.length,
    });
    throw new Error(reason);
  };

  // A mangled revision is usually a one-off model stumble — Haiku dropping an
  // uncommented section, streaming a preamble, etc. Retry once before giving
  // up. A non-zero CLI exit is NOT retried: that's an environment/auth failure
  // a re-run won't fix.
  const MAX_ATTEMPTS = 2;
  let trimmed = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(
      attempt === 1
        ? `Revising with ${provider.id}/${chosenModel}...\n`
        : `\nRetrying revision with ${provider.id}/${chosenModel} (attempt ${attempt}/${MAX_ATTEMPTS})...\n`,
    );
    console.log("─".repeat(60));
    const run = await provider.runRevision({
      systemPrompt,
      userMessage,
      model: chosenModel,
      cwd: process.cwd(),
      onChunk: broadcastChunk,
    });
    revised = run.revised;
    stderrText = run.stderr;
    exitCode = run.exitCode;
    console.log("\n" + "─".repeat(60));
    console.log(
      `Model: ${provider.id}/${chosenModel}  ·  Duration: ${(run.durationMs / 1000).toFixed(1)}s  ·  Exit: ${exitCode}`,
    );
    console.log("─".repeat(60) + "\n");

    // A CLI crash is not retryable — fail immediately.
    if (exitCode !== 0) {
      await fail(
        `${provider.id} CLI exited with code ${exitCode}${stderrText.trim() ? ` — ${stderrText.trim().split("\n").slice(-3).join(" | ")}` : ""}`,
      );
    }

    const result = validateRevision(revised, docText, settled);
    if (result.ok) {
      trimmed = result.doc;
      break;
    }

    // Validation failed — the model returned mangled output. Retry once; on
    // the last attempt, log and throw so the session surfaces the error.
    if (attempt < MAX_ATTEMPTS) {
      console.log(`Revision output rejected: ${result.reason}`);
      continue;
    }
    await fail(result.reason);
  }

  // If the model made no changes, skip the write and signal the browser
  if (trimmed === docText.trim()) {
    console.log("No changes — output identical to input. Skipping file write.");
    await openNextRound(sidecar, filePath);
    try {
      await fetch(`${serverBase()}/api/revision-no-changes`, {
        method: "POST",
        headers: csrfHeader(),
      });
    } catch {
      /* non-fatal */
    }
    return;
  }

  // Write revised document
  await writeFile(filePath, trimmed, "utf-8");

  // Print change summary
  printChangeSummary(docText, trimmed, filePath);

  // Open next round
  await openNextRound(sidecar, filePath);

  // Notify browser to reload
  try {
    await fetch(`${serverBase()}/api/reload`, {
      method: "POST",
      headers: csrfHeader(),
    });
  } catch {
    /* server may not be running — non-fatal */
  }
}

const HEADING_RE = /^#{1,6} .+$/gm;

function normalizeHeadingKey(heading: string): string {
  return (
    heading
      .replace(/^#{1,6}\s+/, "")
      // Milestone/task headings often get legitimately renumbered when a nearby
      // slice is removed. Keep the semantic title as the identity.
      .replace(/^[A-Z]+\d+[a-z]?(?:\.\d+)*:\s+/i, "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
  );
}

function termsForHeading(heading: string): string[] {
  const key = normalizeHeadingKey(heading);
  const words = key.split(/\s+/).filter((w) => w.length >= 4);
  const phrases = new Set<string>();
  const numberedPrefix = heading
    .replace(/^#{1,6}\s+/, "")
    .match(/^([A-Z]+\d+[a-z]?(?:\.\d+)*):\s+/i)?.[1];
  if (numberedPrefix) phrases.add(numberedPrefix.toLowerCase());
  if (words.length >= 2) phrases.add(key);
  for (let size = 2; size <= 3; size++) {
    for (let i = 0; i <= words.length - size; i++) {
      phrases.add(words.slice(i, i + size).join(" "));
    }
  }
  return [...phrases].filter((p) => p.length >= 4);
}

function settledText(settled: Comment[]): string {
  return settled
    .flatMap((c) => [
      c.quote,
      c.context_before,
      c.context_after,
      ...c.thread.flatMap((e) => [e.message, e.revision_reason ?? ""]),
    ])
    .join("\n")
    .toLowerCase();
}

// Headings present in `inputDoc` but missing from `outputDoc` whose section the
// reviewer never authorized touching. A comment quoting text inside a section
// means the reviewer was working there; a thread/revision reason naming the
// section topic also authorizes removal/reworking. Exact heading strings are
// intentionally not the only identity because model revisions may legitimately
// renumber implementation slices after cutting a nearby slice.
function droppedSections(
  inputDoc: string,
  outputDoc: string,
  settled: Comment[],
): string[] {
  const outHeadingKeys = new Set(
    (outputDoc.match(HEADING_RE) ?? []).map(normalizeHeadingKey),
  );
  const inMatches = [...inputDoc.matchAll(HEADING_RE)];
  const quotes = settled.map((c) => c.quote.trim()).filter((q) => q.length > 0);
  const settledTopicText = settledText(settled);

  const unauthorized: string[] = [];
  for (let i = 0; i < inMatches.length; i++) {
    const heading = inMatches[i]![0];
    if (outHeadingKeys.has(normalizeHeadingKey(heading))) continue;
    // This heading's section runs from the heading to the next one (or EOF).
    const start = inMatches[i]!.index!;
    const end =
      i + 1 < inMatches.length ? inMatches[i + 1]!.index! : inputDoc.length;
    const section = inputDoc.slice(start, end);
    const commented = quotes.some((q) => section.includes(q));
    const topicNamed = termsForHeading(heading).some((term) =>
      settledTopicText.includes(term),
    );
    if (!commented && !topicNamed) unauthorized.push(heading);
  }
  return unauthorized;
}

// Validate (and lightly normalize) a revision pass's raw output. Pure — the
// retry loop and tests both drive it. Returns the cleaned document on success,
// or a human-readable reason on failure.
export function validateRevision(
  revised: string,
  inputDoc: string,
  settled: Comment[],
): { ok: true; doc: string } | { ok: false; reason: string } {
  // Strip a wrapping code fence and any <document> wrapper tags the model
  // sometimes includes despite the system prompt.
  let trimmed = revised
    .trim()
    .replace(/^```(?:markdown)?\n([\s\S]*)\n```$/, "$1")
    .replace(/^<document>\s*/i, "")
    .replace(/\s*<\/document>\s*$/i, "")
    .trim();

  // Strip a trailing meta-section the model sometimes appends (Settled
  // comments, Changelog, …), plus a horizontal rule that often precedes it.
  const metaHeading = trimmed.match(
    /\n#{2,3} (Settled comments|Previously agreed changes|Changelog|Revision notes)\b/i,
  );
  if (metaHeading) {
    trimmed = trimmed
      .slice(0, metaHeading.index)
      .trimEnd()
      .replace(/\n+---\s*$/, "")
      .trimEnd();
  }

  if (!trimmed) {
    return {
      ok: false,
      reason: "Revision produced empty output — no text was streamed back",
    };
  }

  // If the input had headings, the output should too. Strip a preamble before
  // the first heading; if there's no heading at all, the model returned prose
  // (an apology, a summary) instead of the document. A genuinely heading-less
  // input is left alone — headings can't be the structural anchor there.
  if (/^#{1,6} /m.test(inputDoc) && !/^#{1,6} /.test(trimmed)) {
    const firstHeadingIdx = trimmed.search(/^#{1,6} /m);
    if (firstHeadingIdx > 0) {
      trimmed = trimmed.slice(firstHeadingIdx).trim();
    } else {
      return {
        ok: false,
        reason:
          "Revision output has no Markdown headings — the model returned non-document content, not a revised document",
      };
    }
  }

  // Structural integrity: the revision must not silently drop a section the
  // reviewer never commented on.
  const dropped = droppedSections(inputDoc, trimmed, settled);
  if (dropped.length > 0) {
    const list = dropped.map((h) => `"${h}"`).join(", ");
    return {
      ok: false,
      reason: `Revision dropped section${dropped.length > 1 ? "s" : ""} the reviewer never commented on: ${list} — the model mangled the document instead of editing it`,
    };
  }

  return { ok: true, doc: trimmed };
}

async function logRevisionFailure(
  filePath: string,
  details: {
    reason: string;
    model: string;
    exitCode: number;
    stderr: string;
    stdoutSample: string;
    stdoutLength: number;
  },
) {
  const logDir = path.join(path.dirname(filePath), ".review");
  await mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, "errors.log");
  const entry =
    `\n=== ${new Date().toISOString()} — ${path.basename(filePath)} ===\n` +
    `reason:       ${details.reason}\n` +
    `model:        ${details.model}\n` +
    `exitCode:     ${details.exitCode}\n` +
    `stdoutLength: ${details.stdoutLength}\n` +
    (details.stderr ? `stderr:\n${details.stderr}\n` : "") +
    (details.stdoutSample
      ? `stdoutSample (first 2000 chars):\n${details.stdoutSample}\n`
      : "") +
    `===\n`;
  try {
    await appendFile(logPath, entry, "utf-8");
    console.error(`Logged failure → .review/errors.log`);
  } catch (e) {
    console.error("Failed to write error log:", e);
  }
}

function printChangeSummary(
  oldText: string,
  newText: string,
  filePath: string,
) {
  const heading = (text: string) => text.match(/^#{1,3} .+$/gm) ?? [];
  const oldH = heading(oldText);
  const newH = heading(newText);

  const added = newH.filter((h) => !oldH.includes(h));
  const removed = oldH.filter((h) => !newH.includes(h));

  console.log(`✓ Revised: ${path.basename(filePath)}`);
  removed.forEach((h) => console.log(`  − Removed: "${h}"`));
  added.forEach((h) => console.log(`  + Added:   "${h}"`));
  if (added.length === 0 && removed.length === 0) {
    console.log("  ~ Sections unchanged, content updated in place");
  }
}

async function openNextRound(
  sidecar: ReturnType<typeof loadSidecar> extends Promise<infer T> ? T : never,
  filePath: string,
) {
  const hasOpenRound = sidecar.rounds.some((r) => r.resolved_at === null);
  if (!hasOpenRound) {
    const nextNum = sidecar.rounds.length + 1;
    sidecar.rounds.push({
      round: nextNum,
      started_at: new Date().toISOString(),
      submitted_at: null,
      agent_replied_at: null,
      resolved_at: null,
      comments: [],
    });
    await saveSidecar(filePath, sidecar);
    console.log(`\nOpened round ${nextNum} — ready for next review.`);
  } else {
    await saveSidecar(filePath, sidecar);
  }
}
