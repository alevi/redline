import { test, expect } from "bun:test";
import { validateRevision } from "../src/resolve";
import type { Comment } from "../src/sidecar";

const DOC =
  "# Aurora\n\n## Headline\n\nFast copy here.\n\n## Body\n\nThe connective tissue.\n";

function comment(quote: string): Comment {
  return {
    id: "c",
    quote,
    context_before: "",
    context_after: "",
    thread: [],
    resolved: true,
  };
}

function commentWithDiscussion(
  quote: string,
  message: string,
  revisionReason?: string,
): Comment {
  return {
    id: "c",
    quote,
    context_before: "",
    context_after: "",
    resolved: true,
    thread: [
      { role: "human", message, at: "" },
      {
        role: "agent",
        message: "Got it.",
        at: "",
        requires_revision: true,
        revision_reason: revisionReason,
      },
    ],
  };
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
  const withMeta =
    DOC.trimEnd() + "\n\n---\n\n## Changelog\n\n- reworded the body\n";
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
  const r = validateRevision(
    "Just a paragraph, revised.\n\nAnd another.\n",
    plain,
    [],
  );
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

test("validateRevision: implementation slice renumbering is not treated as dropped sections", () => {
  const input =
    "# Plan\n\n" +
    "## Implementation Slices\n\n" +
    "### M9a.3: Preview affordance decision\n\nDecide preview behavior.\n\n" +
    "### M9a.4: Email copy and privacy pass\n\nWrite safe email copy.\n\n" +
    "### M9a.5: End-to-end verification\n\nVerify the full flow.\n";
  const output =
    "# Plan\n\n" +
    "## Implementation Slices\n\n" +
    "### M9a.3: Email copy and privacy pass\n\nWrite safe email copy.\n\n" +
    "### M9a.4: End-to-end verification\n\nVerify the full flow.\n";

  const r = validateRevision(output, input, [
    commentWithDiscussion(
      "Preview affordance decision",
      "I don't want to spec partial preview right now.",
      "Remove partial preview from M9a scope throughout the doc.",
    ),
  ]);

  expect(r.ok).toBe(true);
});

test("validateRevision: thread text can authorize dropping a named section topic", () => {
  const input =
    "# Plan\n\n" +
    "## Partial Preview Policy\n\nEarly preview details.\n\n" +
    "## Email Policy\n\nEmail details.\n";
  const output = "# Plan\n\n## Email Policy\n\nEmail details.\n";

  const r = validateRevision(output, input, [
    commentWithDiscussion(
      "early hosted preview",
      "I don't want to spec out the partial preview right now.",
      "Remove partial preview from M9a scope throughout the doc.",
    ),
  ]);

  expect(r.ok).toBe(true);
});

test("validateRevision: Quip Rescue M9a-style preview cut keeps email and verification slices", () => {
  const input =
    "# M9a: Async Completion and Preview Policy\n\n" +
    "## Summary\n\nEmail is the main async promise.\n\n" +
    "## User Experience\n\n" +
    "### Running job dashboard\n\n" +
    "If an early hosted preview is available, the action should be secondary.\n\n" +
    "## Email Policy\n\nSend one completion email.\n\n" +
    "## Partial Preview Policy\n\nSurface completed files while the export is still running.\n\n" +
    "## Non-goals\n\nNo permanent hosted storage promise.\n\n" +
    "## Implementation Slices\n\n" +
    "### M9a.1: Completion email plumbing\n\nAdd email backend configuration.\n\n" +
    "### M9a.2: Dashboard async copy\n\nMake the running-job page safe to close.\n\n" +
    "### M9a.3: Preview affordance decision\n\nDecide whether early preview appears.\n\n" +
    "### M9a.4: Email copy and privacy pass\n\nWrite the completion email copy.\n\n" +
    "### M9a.5: End-to-end verification\n\nVerify the browser can be closed and reopened from email.\n";
  const output =
    "# M9a: Async Completion and Preview Policy\n\n" +
    "## Summary\n\nEmail is the main async promise. Partial preview is deferred.\n\n" +
    "## User Experience\n\n" +
    "### Running job dashboard\n\nThe dashboard says email will be sent when ready.\n\n" +
    "## Email Policy\n\nSend one completion email.\n\n" +
    "## Non-goals\n\nNo permanent hosted storage promise.\n\n" +
    "## Implementation Slices\n\n" +
    "### M9a.1: Completion email plumbing\n\nAdd email backend configuration.\n\n" +
    "### M9a.2: Dashboard async copy\n\nMake the running-job page safe to close.\n\n" +
    "### M9a.3: Email copy and privacy pass\n\nWrite the completion email copy.\n\n" +
    "### M9a.4: End-to-end verification\n\nVerify the browser can be closed and reopened from email.\n";

  const r = validateRevision(output, input, [
    commentWithDiscussion(
      "If an early hosted preview is available",
      "I don't want to spec out the partial preview right now. I think that it is not going to be that useful, so I mostly just want to say that we're not doing it now and we may consider it later.",
      "Remove partial preview from M9a scope throughout the doc — policy section, running-job UX, M9a.3 slice, and acceptance criteria — replacing with a brief deferral note.",
    ),
  ]);

  expect(r.ok).toBe(true);
});

test("validateRevision: Quip Rescue M9a guard still catches unrelated dropped sections", () => {
  const input =
    "# M9a: Async Completion and Preview Policy\n\n" +
    "## Email Policy\n\nSend one completion email.\n\n" +
    "## Implementation Slices\n\n" +
    "### M9a.3: Preview affordance decision\n\nDecide whether early preview appears.\n\n" +
    "### M9a.4: Email copy and privacy pass\n\nWrite the completion email copy.\n\n" +
    "### M9a.5: End-to-end verification\n\nVerify the full flow.\n";
  const output =
    "# M9a: Async Completion and Preview Policy\n\n" +
    "## Implementation Slices\n\n" +
    "### M9a.3: Email copy and privacy pass\n\nWrite the completion email copy.\n";

  const r = validateRevision(output, input, [
    commentWithDiscussion(
      "Preview affordance decision",
      "Partial preview is not useful right now.",
      "Remove partial preview from M9a scope.",
    ),
  ]);

  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.reason).toContain("## Email Policy");
    expect(r.reason).toContain("### M9a.5: End-to-end verification");
  }
});
