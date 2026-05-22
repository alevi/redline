import { describe, test, expect } from "bun:test";
import { pageTemplate } from "./server-page";

const baseArgs = {
  title: "spec.md",
  content: "<p>hello</p>",
  comments: [],
  roundResolved: false,
  agentRepliedAt: null,
  roundNumber: 1,
  totalRounds: 1,
  context: undefined,
  readOnly: false,
  csrfToken: "abc",
  noAgent: false,
};

function render(over: Partial<typeof baseArgs> = {}): string {
  const a = { ...baseArgs, ...over };
  return pageTemplate(
    a.title,
    a.content,
    a.comments,
    a.roundResolved,
    a.agentRepliedAt,
    a.roundNumber,
    a.totalRounds,
    a.context,
    a.readOnly,
    a.csrfToken,
    a.noAgent,
  );
}

describe("pageTemplate — inline diff toggle", () => {
  test("omits the toggle on round 1 (no prior revision to diff against)", () => {
    const html = render({ totalRounds: 1, roundNumber: 1 });
    expect(html).not.toContain('id="btn-toggle-diff"');
  });

  test("renders the toggle on round 2+ in the live view", () => {
    const html = render({ totalRounds: 2, roundNumber: 2 });
    expect(html).toContain('id="btn-toggle-diff"');
    expect(html).toContain("Show changes");
    expect(html).toContain('aria-pressed="false"');
  });

  test("omits the toggle in read-only previous-round views", () => {
    // The /api/diff endpoint compares current file to latest snapshot,
    // which would be misleading on a historical round page.
    const html = render({ totalRounds: 3, roundNumber: 1, readOnly: true });
    expect(html).not.toContain('id="btn-toggle-diff"');
  });
});
