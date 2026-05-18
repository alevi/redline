// Validation harness for the diff change.
//
// Renders the same before/after markdown under TWO algorithms:
//   - "old": only adjacent delete+insert pairs merge into a word-level modify.
//   - "new": deletes and inserts inside any non-equal run are paired by
//            Jaccard similarity over word tokens.
// Writes a single HTML page to /tmp so you can eyeball them side by side.
//
// Run: bun run scripts/diff-compare.ts

import { writeFileSync } from "fs";
import { renderMarkdown } from "../src/render";
import {
  splitBlocks,
  lcsOps,
  wordDiffMarkdown,
  renderDocDiff,
  type DiffOp,
} from "../src/diff";

// Old merge: only adjacent del+ins → modify. Anything else stays as-is.
function renderDocDiffOld(oldText: string, newText: string): string {
  const oldBlocks = splitBlocks(oldText);
  const newBlocks = splitBlocks(newText);
  const raw = lcsOps(oldBlocks, newBlocks, (a, b) => a === b);

  type MergedOp = {
    type: "equal" | "insert" | "delete" | "modify";
    a?: string;
    b?: string;
  };
  const ops: MergedOp[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (
      raw[i].type === "delete" &&
      i + 1 < raw.length &&
      raw[i + 1].type === "insert"
    ) {
      ops.push({ type: "modify", a: raw[i].aVal, b: raw[i + 1].bVal });
      i++;
    } else {
      ops.push({ type: raw[i].type as any, a: raw[i].aVal, b: raw[i].bVal });
    }
  }

  if (ops.every((o) => o.type === "equal")) {
    return '<div class="diff-no-changes">No changes between versions.</div>';
  }

  let html = '<div class="diff-prose">';
  for (const op of ops) {
    if (op.type === "equal") html += renderMarkdown(op.b!);
    else if (op.type === "insert")
      html += `<div class="diff-block diff-block-add">${renderMarkdown(op.b!)}</div>`;
    else if (op.type === "delete")
      html += `<div class="diff-block diff-block-del">${renderMarkdown(op.a!)}</div>`;
    else {
      const isCode =
        op.a!.trimStart().startsWith("```") ||
        op.b!.trimStart().startsWith("```");
      if (isCode) {
        html += `<div class="diff-block diff-block-del">${renderMarkdown(op.a!)}</div>`;
        html += `<div class="diff-block diff-block-add">${renderMarkdown(op.b!)}</div>`;
      } else {
        html += `<div class="diff-block diff-block-mod">${renderMarkdown(wordDiffMarkdown(op.a!, op.b!))}</div>`;
      }
    }
  }
  html += "</div>";
  return html;
}

// Realistic before/after: an RFC-style brief that the agent has revised.
// Multiple consecutive paragraphs reworded, one section restructured, one
// new section added, one paragraph removed, one bullet list edited, and one
// code-block change. This is the worst case for the old algorithm.
const before = `# Email Triage Worker

## Goal

We want a small worker that reads the user's inbox, classifies each thread, and posts a daily digest to Slack. The classifier runs on a schedule and writes its output to a Postgres table.

## Constraints

The worker has to live inside our existing Cloudflare account because that is where our DNS and zero-trust setup already terminates. We cannot move it to AWS for this iteration. We also need to keep the per-classification cost under one cent so that the digest stays viable for free-tier users.

Latency is not a primary concern. The digest is fired off once a day, so a classification run that takes 90 seconds is perfectly fine.

## Approach

1. A scheduled Worker fires every morning at 7am local time.
2. It pulls the last 24 hours of threads from Gmail using a stored refresh token.
3. Each thread is sent to Haiku with a short classification prompt.
4. Results are written to a \`triage_runs\` table.

## Open questions

- Should we backfill old threads on first install, or start from "now"?
- Do we need a per-user opt-out for specific senders?

\`\`\`ts
const PROMPT = "Classify this thread as: action, fyi, or noise.";
\`\`\`
`;

const after = `# Email Triage Worker

## Goal

A small worker reads the user's inbox, classifies each thread, and posts a daily digest to Slack. The classifier runs on a fixed schedule and persists its output to a Postgres table for later review.

## Constraints

The worker must live inside our existing Cloudflare account, because that is where DNS and zero-trust already terminate. Moving to AWS is out of scope for this iteration. Per-classification cost should stay under one cent so the digest remains viable for free-tier users.

End-to-end latency is not a primary concern: the digest fires once a day, so a 90-second run is acceptable.

## Approach

1. A scheduled Worker fires every weekday morning at 7am in the user's local timezone.
2. It pulls the last 24 hours of threads from Gmail using the stored refresh token.
3. Each thread is sent to Haiku with a short classification prompt and a one-shot example.
4. Results are written to a \`triage_runs\` table, one row per thread.

## Failure modes

If Gmail's API is throttling us, we should back off exponentially and surface a "skipped today" entry in the next digest rather than dropping the run silently.

## Open questions

- Should we backfill old threads on first install, or start from "now"?
- Do we need a per-user allowlist of senders to always classify as action?
- How do we handle threads that span more than 24 hours?

\`\`\`ts
const PROMPT = "Classify this thread as one of: action, fyi, noise, or newsletter.";
\`\`\`
`;

const oldHtml = renderDocDiffOld(before, after);
const newHtml = renderDocDiff(before, after);

// Crude metric for the user's complaint: how much content lives inside whole
// red/green blocks vs inside word-level marks within modify blocks.
function measure(html: string) {
  const blockMatches = html.match(/diff-block-(add|del)/g) ?? [];
  const modMatches = html.match(/diff-block-mod/g) ?? [];
  const wordAdd = html.match(/diff-word-add/g) ?? [];
  const wordDel = html.match(/diff-word-del/g) ?? [];
  return {
    blockLevelAddDel: blockMatches.length,
    blockLevelMod: modMatches.length,
    wordLevelMarks: wordAdd.length + wordDel.length,
  };
}

const oldStats = measure(oldHtml);
const newStats = measure(newHtml);
console.log("OLD algorithm:", oldStats);
console.log("NEW algorithm:", newStats);

// Inline the same diff CSS the live overlay uses so the rendered HTML looks
// identical to what you see in the actual reader.
const css = `
:root { --border:#e7e5e0; --text:#262626; --text-muted:#737373; --thread-bg:#fafaf7; --radius:6px; }
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; margin:0; padding:24px; color:var(--text); background:#f5f5f0; }
h1.page-title { font-size:18px; margin:0 0 4px; }
.subtitle { color:var(--text-muted); font-size:13px; margin:0 0 24px; }
.cols { display:grid; grid-template-columns:1fr 1fr; gap:24px; align-items:start; }
.col { background:white; border:1px solid var(--border); border-radius:8px; padding:24px 32px; }
.col h2 { margin:0 0 4px; font-size:15px; }
.col .label { font-size:12px; color:var(--text-muted); margin-bottom:16px; }
.metrics { font-size:12px; color:var(--text-muted); font-family:'Menlo','Monaco',monospace; margin-bottom:16px; padding:8px 12px; background:#fafaf7; border-radius:4px; }
.diff-prose { max-width:none; margin:0; }
.diff-prose h1 { font-size:1.6em; font-weight:700; margin:1.2em 0 0.4em; }
.diff-prose h2 { font-size:1.25em; font-weight:700; margin:1.2em 0 0.4em; padding-bottom:0.25em; border-bottom:1px solid var(--border); }
.diff-prose h3 { font-size:1.05em; font-weight:600; margin:1em 0 0.3em; }
.diff-prose p { margin:0.7em 0; line-height:1.65; }
.diff-prose pre { background:#f6f8fa; border-radius:6px; padding:12px 14px; overflow-x:auto; font-size:13px; }
.diff-prose code { font-family:'Menlo','Monaco',monospace; font-size:0.875em; background:#f0f0ed; padding:1px 4px; border-radius:3px; }
.diff-prose pre code { background:none; padding:0; }
.diff-prose ul, .diff-prose ol { padding-left:1.5em; margin:0.7em 0; }
.diff-prose li { margin:0.25em 0; line-height:1.65; }
.diff-block { border-radius:4px; margin:2px -12px; padding:2px 12px; }
.diff-block-add { background:#e6ffed; border-left:3px solid #28a745; }
.diff-block-del { background:#ffeef0; border-left:3px solid #d73a49; opacity:0.8; }
.diff-block-mod { background:#fffbe6; border-left:3px solid #f0ad00; }
ins.diff-word-add { background:#acf2bd; text-decoration:none; border-radius:2px; padding:0 1px; }
del.diff-word-del { background:#fdb8c0; border-radius:2px; padding:0 1px; }
.diff-no-changes { padding:24px 0; color:var(--text-muted); }
`;

const stat = (s: ReturnType<typeof measure>) =>
  `block-level add/del: ${s.blockLevelAddDel}  ·  modify blocks: ${s.blockLevelMod}  ·  word-level marks: ${s.wordLevelMarks}`;

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>Redline diff: old vs new</title><style>${css}</style></head>
<body>
  <h1 class="page-title">Redline diff comparison</h1>
  <p class="subtitle">Same before/after markdown rendered with the old (adjacent-only merge) vs new (similarity-pairing) algorithm.</p>
  <div class="cols">
    <div class="col">
      <h2>Old algorithm</h2>
      <div class="label">Only adjacent delete+insert pairs merge into a word-level modify.</div>
      <div class="metrics">${stat(oldStats)}</div>
      ${oldHtml}
    </div>
    <div class="col">
      <h2>New algorithm</h2>
      <div class="label">Deletes and inserts in any non-equal run are paired by Jaccard similarity (≥ 0.25).</div>
      <div class="metrics">${stat(newStats)}</div>
      ${newHtml}
    </div>
  </div>
</body></html>
`;

const outPath = "/tmp/redline-diff-compare.html";
writeFileSync(outPath, page, "utf-8");
console.log(`\nWrote ${outPath}`);
