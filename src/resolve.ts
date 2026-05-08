import { appendFile, copyFile, mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { loadSidecar, saveSidecar } from "./sidecar";
import type { Round } from "./sidecar";
import { pickRevisionModel } from "./pickModel";

const serverBase = () => `http://localhost:${process.env.REDLINE_PORT ?? "3000"}`;
const csrfHeader = (): Record<string, string> => ({ "X-Redline-Token": process.env.REDLINE_TOKEN ?? "" });

export async function resolve(filePath: string, options: { model?: string } = {}) {
  const model = options.model ?? null;
  const sidecar = await loadSidecar(filePath);

  // Find the most recently accepted round
  const resolvedRounds = sidecar.rounds.filter((r) => r.resolved_at != null);
  if (resolvedRounds.length === 0) {
    throw new Error("No accepted round found — human must click 'Accept & revise' first");
  }
  const round: Round = resolvedRounds[resolvedRounds.length - 1];
  const settled = round.comments.filter((c) => c.resolved);
  const chosenModel = model ?? pickRevisionModel(settled);

  const docText = await readFile(filePath, "utf-8");

  // Save history snapshot before any changes
  const historyDir = path.join(path.dirname(filePath), ".review", "history");
  await mkdir(historyDir, { recursive: true });
  const snapTs = new Date().toISOString();
  const snapFile = path.join(historyDir, `${path.basename(filePath)}.${snapTs}.md`);
  await copyFile(filePath, snapFile);
  console.log(`Saved snapshot → .review/history/${path.basename(snapFile)}\n`);

  if (settled.length === 0) {
    console.log("No settled comments — no revision needed.");
    await openNextRound(sidecar, filePath);
    try { await fetch(`${serverBase()}/api/reload`, { method: "POST", headers: csrfHeader() }); } catch { /* non-fatal */ }
    return;
  }

  // Build prompt
  const commentsBlock = settled
    .map((c, i) => {
      const discussion = c.thread
        .map((e) => `    ${e.role === "agent" ? "Agent" : "Reviewer"}: ${e.message}`)
        .join("\n");
      return `${i + 1}. Quote: "${c.quote}"\n   Discussion:\n${discussion}`;
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
          const lastAgent = [...c.thread].reverse().find((e) => e.role === "agent");
          return `- Round ${r.round}: "${c.quote}" → ${lastAgent?.message ?? "(resolved)"}`;
        })
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
    "The output should look like a clean revision of the original document — as if a human editor made the changes silently.";

  const userMessage =
    `<comments-to-apply>\n${commentsBlock}\n</comments-to-apply>${priorChangesBlock}\n\n<document>\n${docText}\n</document>`;

  // Call the claude CLI (inherits auth from the user's Claude Code session — no API key needed)
  console.log(`Revising with ${chosenModel}...\n`);
  console.log("─".repeat(60));

  const cliBin = process.env.CLAUDE_CODE_EXECPATH ?? "claude";
  const proc = Bun.spawn(
    [cliBin, "-p", "--system-prompt", systemPrompt, "--model", chosenModel,
     "--output-format", "stream-json", "--include-partial-messages", "--verbose"],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  proc.stdin.write(userMessage);
  proc.stdin.end();

  // Drain stderr concurrently so we can include it in any error report
  let stderrText = "";
  (async () => {
    const r = proc.stderr.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await r.read();
      if (done) break;
      const chunk = dec.decode(value);
      stderrText += chunk;
      process.stderr.write(chunk);
    }
  })();

  let revised = "";
  let buffer = "";
  const reader = proc.stdout.getReader();
  const broadcastChunk = (text: string, kind: "thinking" | "text") => {
    fetch(`${serverBase()}/api/revision-chunk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeader() },
      body: JSON.stringify({ text, kind }),
    }).catch(() => {});
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += new TextDecoder().decode(value);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "stream_event" && obj.event?.type === "content_block_delta") {
          const delta = obj.event.delta;
          if (delta?.type === "text_delta" && delta.text) {
            revised += delta.text;
            process.stdout.write(delta.text);
            broadcastChunk(delta.text, "text");
          } else if (delta?.type === "thinking_delta" && delta.thinking) {
            broadcastChunk(delta.thinking, "thinking");
          }
        }
      } catch { /* malformed JSON line, skip */ }
    }
  }

  const exitCode = await proc.exited;
  console.log("\n" + "─".repeat(60) + "\n");

  const fail = async (reason: string) => {
    await logRevisionFailure(filePath, {
      reason,
      model: chosenModel,
      exitCode,
      stderr: stderrText.trim(),
      stdoutSample: revised.slice(0, 2000),
      stdoutLength: revised.length,
    });
    throw new Error(reason);
  };

  if (exitCode !== 0) {
    await fail(`claude CLI exited with code ${exitCode}${stderrText.trim() ? ` — ${stderrText.trim().split("\n").slice(-3).join(" | ")}` : ""}`);
  }

  // Validate output. Strip a wrapping code fence if present, a preamble before the
  // first heading, any <document> wrapper tags, and any meta-sections the model
  // sometimes appends (Settled comments, Previously agreed changes, Changelog).
  let trimmed = revised.trim()
    .replace(/^```(?:markdown)?\n([\s\S]*)\n```$/, "$1")
    .replace(/^<document>\s*/i, "")
    .replace(/\s*<\/document>\s*$/i, "")
    .trim();
  // Strip trailing meta-sections at any heading level (## or ###).
  const metaHeading = trimmed.match(/\n#{2,3} (Settled comments|Previously agreed changes|Changelog|Revision notes)\b/i);
  if (metaHeading) {
    console.log(`Stripping trailing meta-section: ${metaHeading[1]}`);
    trimmed = trimmed.slice(0, metaHeading.index).trimEnd();
    // Strip a trailing horizontal rule that often precedes the meta-section.
    trimmed = trimmed.replace(/\n+---\s*$/, "").trimEnd();
  }
  if (!trimmed) {
    await fail("Agent returned empty output (no text deltas streamed)");
  }
  if (!trimmed.startsWith("#")) {
    const firstHeadingIdx = trimmed.search(/^# /m);
    if (firstHeadingIdx > 0) {
      console.log("Stripping preamble before first heading.");
      trimmed = trimmed.slice(firstHeadingIdx).trim();
    } else {
      await fail("Output contains no Markdown heading — model returned non-document content");
    }
  }

  // If the model made no changes, skip the write and signal the browser
  if (trimmed === docText.trim()) {
    console.log("No changes — output identical to input. Skipping file write.");
    await openNextRound(sidecar, filePath);
    try { await fetch(`${serverBase()}/api/revision-no-changes`, { method: "POST", headers: csrfHeader() }); } catch { /* non-fatal */ }
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
    await fetch(`${serverBase()}/api/reload`, { method: "POST", headers: csrfHeader() });
  } catch { /* server may not be running — non-fatal */ }
}

async function logRevisionFailure(
  filePath: string,
  details: { reason: string; model: string; exitCode: number; stderr: string; stdoutSample: string; stdoutLength: number }
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
    (details.stdoutSample ? `stdoutSample (first 2000 chars):\n${details.stdoutSample}\n` : "") +
    `===\n`;
  try {
    await appendFile(logPath, entry, "utf-8");
    console.error(`Logged failure → .review/errors.log`);
  } catch (e) {
    console.error("Failed to write error log:", e);
  }
}

function printChangeSummary(oldText: string, newText: string, filePath: string) {
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

async function openNextRound(sidecar: ReturnType<typeof loadSidecar> extends Promise<infer T> ? T : never, filePath: string) {
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
