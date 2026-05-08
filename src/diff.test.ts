import { test, expect } from "bun:test";
import {
  splitBlocks,
  lcsOps,
  wordDiffMarkdown,
  blockSimilarity,
  mergeDiffOps,
  renderDocDiff,
} from "./diff";

test("splitBlocks splits on blank lines and keeps fenced code together", () => {
  const text = "para one\n\npara two\n\n```\nline a\n\nline b\n```\n\nlast";
  expect(splitBlocks(text)).toEqual([
    "para one",
    "para two",
    "```\nline a\n\nline b\n```",
    "last",
  ]);
});

test("blockSimilarity is high for reworded paragraphs", () => {
  const a = "The quick brown fox jumps over the lazy dog";
  const b = "The quick brown fox leaped over the lazy dog";
  expect(blockSimilarity(a, b)).toBeGreaterThan(0.7);
});

test("blockSimilarity is low for unrelated text", () => {
  expect(blockSimilarity("alpha beta gamma", "completely different stuff")).toBeLessThan(0.25);
});

test("mergeDiffOps pairs reworded paragraphs across a multi-paragraph run", () => {
  // Two adjacent paragraphs both got reworded. The naive adjacent-only merge
  // would emit modify(p1', p1''), delete(p2'), insert(p2'') — leaving a big
  // red and big green block. Similarity pairing should produce two modifies.
  const oldText = [
    "Intro line.",
    "",
    "The first section talks about apples and oranges and bananas.",
    "",
    "The second section talks about cars and planes and trains.",
    "",
    "Outro line.",
  ].join("\n");
  const newText = [
    "Intro line.",
    "",
    "First section now mentions apples, pears, and bananas in detail.",
    "",
    "Second section now mentions cars, trucks, and trains in detail.",
    "",
    "Outro line.",
  ].join("\n");
  const oldBlocks = splitBlocks(oldText);
  const newBlocks = splitBlocks(newText);
  const raw = lcsOps(oldBlocks, newBlocks, (a, b) => a === b);
  const merged = mergeDiffOps(raw);
  const modifies = merged.filter((o) => o.type === "modify");
  const dels = merged.filter((o) => o.type === "delete");
  const ins = merged.filter((o) => o.type === "insert");
  expect(modifies.length).toBe(2);
  expect(dels.length).toBe(0);
  expect(ins.length).toBe(0);
});

test("mergeDiffOps leaves unrelated additions as pure inserts", () => {
  const oldText = "Paragraph about cats.\n\nUnrelated stale paragraph.";
  const newText = "Paragraph about cats and dogs.\n\nA brand new sentence about quantum mechanics.";
  const oldBlocks = splitBlocks(oldText);
  const newBlocks = splitBlocks(newText);
  const merged = mergeDiffOps(lcsOps(oldBlocks, newBlocks, (a, b) => a === b));
  // First paragraph: modify (cats → cats and dogs).
  // Second paragraph: low similarity → delete + insert.
  expect(merged.some((o) => o.type === "modify")).toBe(true);
  expect(merged.some((o) => o.type === "delete")).toBe(true);
  expect(merged.some((o) => o.type === "insert")).toBe(true);
});

test("renderDocDiff produces word-level marks for reworded paragraphs", () => {
  const oldText = "The fox jumps over the dog.";
  const newText = "The fox leaps over the dog.";
  const html = renderDocDiff(oldText, newText);
  expect(html).toContain("diff-block-mod");
  expect(html).toContain("diff-word-del");
  expect(html).toContain("diff-word-add");
  // Should NOT degenerate to a full block-level del/add.
  expect(html).not.toContain("diff-block-del");
  expect(html).not.toContain("diff-block-add");
});

test("renderDocDiff returns no-changes sentinel when identical", () => {
  expect(renderDocDiff("hello\n\nworld", "hello\n\nworld")).toContain("diff-no-changes");
});

test("wordDiffMarkdown highlights only the changed words", () => {
  const out = wordDiffMarkdown("The fox jumps", "The fox leaps");
  expect(out).toContain("<del");
  expect(out).toContain("jumps");
  expect(out).toContain("<ins");
  expect(out).toContain("leaps");
  expect(out).toContain("The fox");
});
