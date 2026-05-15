import { test, expect } from "bun:test";
import { validateRevision } from "../src/resolve";
import type { Comment } from "../src/sidecar";

const DOC =
  "# Aurora\n\n## Headline\n\nFast copy here.\n\n## Body\n\nThe connective tissue.\n";

function comment(quote: string): Comment {
  return { id: "c", quote, context_before: "", context_after: "", thread: [], resolved: true };
}

test("validateRevision: clean unchanged doc passes", () => {
  const r = validateRevision(DOC, DOC, []);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.doc).toBe(DOC.trim());
});

test("validateRevision: strips a wrapping ```markdown fence", () => {
  const fenced = "```markdown\n" + DOC.trimEnd() + "\n```";
  const r = validateRevision(fenced, DOC, []);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.doc).toBe(DOC.trim());
});

test("validateRevision: strips <document> wrapper tags", () => {
  const wrapped = "<document>\n" + DOC.trimEnd() + "\n</document>";
  const r = validateRevision(wrapped, DOC, []);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.doc).toBe(DOC.trim());
});

test("validateRevision: strips a trailing meta-section", () => {
  const withMeta = DOC.trimEnd() + "\n\n---\n\n## Changelog\n\n- reworded the body\n";
  const r = validateRevision(withMeta, DOC, []);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.doc).not.toContain("Changelog");
    expect(r.doc.endsWith("The connective tissue.")).toBe(true);
  }
});

test("validateRevision: strips a preamble before the first heading", () => {
  const withPreamble = "Here is the revised document:\n\n" + DOC;
  const r = validateRevision(withPreamble, DOC, []);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.doc.startsWith("# Aurora")).toBe(true);
});

test("validateRevision: empty output fails", () => {
  const r = validateRevision("   \n  ", DOC, []);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("empty output");
});

test("validateRevision: prose-only output (input had headings) fails", () => {
  const r = validateRevision("I'm sorry, I can't revise that.", DOC, []);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("no Markdown headings");
});

test("validateRevision: a genuinely heading-less document passes", () => {
  const plain = "Just a paragraph.\n\nAnd another.\n";
  const r = validateRevision("Just a paragraph, revised.\n\nAnd another.\n", plain, []);
  expect(r.ok).toBe(true);
});

test("validateRevision: dropping uncommented sections fails (the Aurora case)", () => {
  // Model dropped the title + headline; only the Body had a comment.
  const mangled = "Fast copy here.\n\n## Body\n\nThe glue.\n";
  const r = validateRevision(mangled, DOC, [comment("connective tissue")]);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.reason).toContain("dropped section");
    expect(r.reason).toContain("# Aurora");
    expect(r.reason).toContain("## Headline");
  }
});

test("validateRevision: dropping a section the reviewer commented on is allowed", () => {
  // ## Headline is gone, but a comment quoted into it — an authorized cut.
  const cut = "# Aurora\n\n## Body\n\nThe glue.\n";
  const r = validateRevision(cut, DOC, [comment("Fast copy here.")]);
  expect(r.ok).toBe(true);
});
