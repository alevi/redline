import { copyFile, mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { loadSidecar, saveSidecar } from "./sidecar";
import type { Round } from "./sidecar";
import { pickRevisionModel } from "./pickModel";

export async function resolve(filePath: string, options: { model?: string } = {}) {
  const model = options.model ?? null;
  const sidecar = await loadSidecar(filePath);

  // Find the most recently accepted round
  const resolvedRounds = sidecar.rounds.filter((r) => r.resolved_at != null);
  if (resolvedRounds.length === 0) {
    console.error("No accepted round found — human must click 'Accept & revise' first.");
    process.exit(1);
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
    try { await fetch("http://localhost:3000/api/reload", { method: "POST" }); } catch { /* non-fatal */ }
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

  const systemPrompt =
    "You are revising a Markdown document based on settled reviewer comments.\n" +
    "For each comment, edit the relevant passage to reflect what was agreed.\n" +
    "Preserve all sections with no comments exactly as they are.\n" +
    "Do not add commentary or explanation. Return only the revised Markdown document.";

  const userMessage =
    `## Document\n\n${docText}\n\n---\n\n## Settled comments\n\n${commentsBlock}`;

  // Call the claude CLI (inherits auth from the user's Claude Code session — no API key needed)
  console.log(`Revising with ${chosenModel}...\n`);
  console.log("─".repeat(60));

  const cliBin = process.env.CLAUDE_CODE_EXECPATH ?? "claude";
  const proc = Bun.spawn(
    [cliBin, "-p", "--system-prompt", systemPrompt, "--model", chosenModel],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    }
  );

  proc.stdin.write(userMessage);
  proc.stdin.end();

  let revised = "";
  const reader = proc.stdout.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = new TextDecoder().decode(value);
    process.stdout.write(chunk);
    revised += chunk;
  }

  const exitCode = await proc.exited;
  console.log("\n" + "─".repeat(60) + "\n");

  if (exitCode !== 0) {
    console.error(`claude CLI exited with code ${exitCode} — aborting. Original file untouched.`);
    process.exit(1);
  }

  // Validate output
  const trimmed = revised.trim().replace(/^```(?:markdown)?\n([\s\S]*)\n```$/, "$1").trim();
  if (!trimmed) {
    console.error("Agent returned empty output — aborting. Original file untouched.");
    process.exit(1);
  }
  if (!trimmed.startsWith("#")) {
    console.error("Output doesn't start with a Markdown heading — aborting. Original file untouched.");
    process.exit(1);
  }

  // Write revised document
  await writeFile(filePath, trimmed, "utf-8");

  // Print change summary
  printChangeSummary(docText, trimmed, filePath);

  // Open next round
  await openNextRound(sidecar, filePath);

  // Notify browser to reload
  try {
    await fetch("http://localhost:3000/api/reload", { method: "POST" });
  } catch { /* server may not be running — non-fatal */ }
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
