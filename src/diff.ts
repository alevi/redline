import { renderMarkdown } from "./render";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function splitBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) inFence = !inFence;
    if (!inFence && line.trim() === '') {
      if (current.length > 0) { blocks.push(current.join('\n')); current = []; }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks.filter(b => b.trim().length > 0);
}

export type DiffOp<T> = {type: 'equal'|'insert'|'delete', aVal?: T, bVal?: T};

export function lcsOps<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): Array<DiffOp<T>> {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({length: m+1}, () => new Array(n+1).fill(0));
  for (let i = m-1; i >= 0; i--)
    for (let j = n-1; j >= 0; j--)
      dp[i][j] = eq(a[i], b[j]) ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
  const ops: Array<DiffOp<T>> = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && eq(a[i], b[j])) { ops.push({type: 'equal', aVal: a[i], bVal: b[j]}); i++; j++; }
    else if (j < n && (i >= m || dp[i][j+1] >= dp[i+1][j])) { ops.push({type: 'insert', bVal: b[j]}); j++; }
    else { ops.push({type: 'delete', aVal: a[i]}); i++; }
  }
  return ops;
}

export function wordDiffMarkdown(oldStr: string, newStr: string): string {
  const tokens = (s: string) => s.match(/\S+|\s+/g) ?? [];
  const ops = lcsOps(tokens(oldStr), tokens(newStr), (a, b) => a === b);
  return ops.map(op => {
    if (op.type === 'equal') return op.aVal!;
    if (op.type === 'insert') return `<ins class="diff-word-add">${escapeHtml(op.bVal!)}</ins>`;
    return `<del class="diff-word-del">${escapeHtml(op.aVal!)}</del>`;
  }).join('');
}

// Jaccard similarity over normalized word tokens. Used to decide whether a
// deleted block and an inserted block are similar enough to render as a
// word-level "modify" rather than as two separate red/green chunks.
export function blockSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const setA = new Set(norm(a));
  const setB = new Set(norm(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return inter / (setA.size + setB.size - inter);
}

export type MergedOp = {type: 'equal'|'insert'|'delete'|'modify', a?: string, b?: string};

// Threshold tuned empirically: paragraphs that share ~25% of their content
// usually represent the same idea reworded, while pairs below this are
// independent edits that read more clearly as separate add/remove blocks.
const SIMILARITY_THRESHOLD = 0.25;

// Walk LCS output and pair up deletes with inserts inside each contiguous
// non-equal run by similarity. This is what keeps reworded paragraphs from
// rendering as a wall of red followed by a wall of green.
export function mergeDiffOps(raw: Array<DiffOp<string>>): MergedOp[] {
  const out: MergedOp[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i].type === 'equal') {
      out.push({type: 'equal', a: raw[i].aVal, b: raw[i].bVal});
      i++;
      continue;
    }
    // Collect this run of non-equal ops.
    const runStart = i;
    while (i < raw.length && raw[i].type !== 'equal') i++;
    const run = raw.slice(runStart, i);
    const dels = run.map((op, idx) => ({op, idx})).filter(x => x.op.type === 'delete');
    const inss = run.map((op, idx) => ({op, idx})).filter(x => x.op.type === 'insert');

    // Score every (del, ins) pair, pick greedily best-first above threshold.
    type Pair = {dIdx: number, iIdx: number, score: number};
    const pairs: Pair[] = [];
    for (const d of dels) for (const ins of inss) {
      const score = blockSimilarity(d.op.aVal!, ins.op.bVal!);
      if (score >= SIMILARITY_THRESHOLD) pairs.push({dIdx: d.idx, iIdx: ins.idx, score});
    }
    pairs.sort((a, b) => b.score - a.score);
    const dPaired = new Map<number, number>(); // run-local del idx -> ins idx
    const iPaired = new Set<number>();
    for (const p of pairs) {
      if (dPaired.has(p.dIdx) || iPaired.has(p.iIdx)) continue;
      dPaired.set(p.dIdx, p.iIdx);
      iPaired.add(p.iIdx);
    }

    // Emit in run order: each delete becomes a modify if paired, otherwise
    // a plain delete. After all deletes, emit unpaired inserts in their
    // original order. Paired inserts are skipped (consumed by the modify).
    for (let k = 0; k < run.length; k++) {
      const op = run[k];
      if (op.type === 'delete') {
        const pairedInsIdx = dPaired.get(k);
        if (pairedInsIdx !== undefined) {
          out.push({type: 'modify', a: op.aVal, b: run[pairedInsIdx].bVal});
        } else {
          out.push({type: 'delete', a: op.aVal});
        }
      }
    }
    for (let k = 0; k < run.length; k++) {
      const op = run[k];
      if (op.type === 'insert' && !iPaired.has(k)) {
        out.push({type: 'insert', b: op.bVal});
      }
    }
  }
  return out;
}

export function renderDocDiff(oldText: string, newText: string): string {
  const oldBlocks = splitBlocks(oldText);
  const newBlocks = splitBlocks(newText);
  const raw = lcsOps(oldBlocks, newBlocks, (a, b) => a === b);
  const ops = mergeDiffOps(raw);

  if (ops.every(op => op.type === 'equal')) {
    return '<div class="diff-no-changes">No changes between versions.</div>';
  }

  let html = '<div class="diff-prose">';
  for (const op of ops) {
    if (op.type === 'equal') {
      html += renderMarkdown(op.b!);
    } else if (op.type === 'insert') {
      html += `<div class="diff-block diff-block-add">${renderMarkdown(op.b!)}</div>`;
    } else if (op.type === 'delete') {
      html += `<div class="diff-block diff-block-del">${renderMarkdown(op.a!)}</div>`;
    } else {
      const isCode = op.a!.trimStart().startsWith('```') || op.b!.trimStart().startsWith('```');
      if (isCode) {
        html += `<div class="diff-block diff-block-del">${renderMarkdown(op.a!)}</div>`;
        html += `<div class="diff-block diff-block-add">${renderMarkdown(op.b!)}</div>`;
      } else {
        html += `<div class="diff-block diff-block-mod">${renderMarkdown(wordDiffMarkdown(op.a!, op.b!))}</div>`;
      }
    }
  }
  html += '</div>';
  return html;
}
