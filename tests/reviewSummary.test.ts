import { test, expect } from "bun:test";
import { formatReviewSummary, collectEscalations } from "../src/reviewSummary";
import type { Sidecar } from "../src/sidecar";

function sidecar(): Sidecar {
  return {
    file: "brief.md",
    rounds: [
      {
        round: 1,
        started_at: "",
        submitted_at: null,
        agent_replied_at: null,
        resolved_at: "x",
        comments: [
          {
            id: "a",
            quote: "the em dash here",
            context_before: "",
            context_after: "",
            resolved: true,
            thread: [
              { role: "human", message: "Did you run the copy guidelines on this?", at: "" },
              { role: "agent", name: "Claude", message: "I don't have them — routed to the launching agent.", at: "", escalate: true },
              { role: "human", message: "Give the feedback to the outer agent.", at: "" },
            ],
          },
          {
            id: "b",
            quote: "plain typo",
            context_before: "",
            context_after: "",
            resolved: true,
            thread: [
              { role: "human", message: "typo", at: "" },
              { role: "agent", name: "Claude", message: "Got it.", at: "", requires_revision: true, revision_reason: "fix typo" },
            ],
          },
        ],
      },
    ],
  };
}

test("collectEscalations finds escalated comments with the triggering request", () => {
  const esc = collectEscalations(sidecar());
  expect(esc.length).toBe(1);
  expect(esc[0]!.quote).toBe("the em dash here");
  expect(esc[0]!.round).toBe(1);
  expect(esc[0]!.request).toBe("Did you run the copy guidelines on this?");
});

test("formatReviewSummary lists threads and an escalation callout", () => {
  const out = formatReviewSummary(sidecar());
  expect(out).toContain("Round 1");
  expect(out).toContain("escalated");
  expect(out).toContain("Reviewer: Give the feedback to the outer agent.");
  expect(out).toContain("1 comment escalated to you");
});

test("formatReviewSummary omits the callout when nothing escalated", () => {
  const s = sidecar();
  s.rounds[0]!.comments = [s.rounds[0]!.comments[1]!];
  const out = formatReviewSummary(s);
  expect(out).not.toContain("escalated to you");
});

test("collectEscalations: escalation with no preceding human message has empty request", () => {
  const s = sidecar();
  s.rounds[0]!.comments[0]!.thread = [
    { role: "agent", name: "Claude", message: "Escalating this one.", escalate: true },
  ];
  const esc = collectEscalations(s);
  expect(esc).toHaveLength(1);
  expect(esc[0]!.request).toBe("");
  expect(esc[0]!.note).toBe("Escalating this one.");
});

test("collectEscalations: revision_reason is preferred over message for the note", () => {
  const s = sidecar();
  s.rounds[0]!.comments[0]!.thread = [
    { role: "human", message: "check the spec", at: "" },
    { role: "agent", name: "Claude", message: "On it.", escalate: true, revision_reason: "needs the external spec" },
  ];
  const esc = collectEscalations(s);
  expect(esc[0]!.note).toBe("needs the external spec");
});

test("collectEscalations: multiple escalations across rounds, in order", () => {
  const s = sidecar();
  s.rounds.push({
    round: 2,
    started_at: "", submitted_at: null, agent_replied_at: null, resolved_at: "x",
    comments: [{
      id: "c", quote: "round two quote", context_before: "", context_after: "", resolved: true,
      thread: [
        { role: "human", message: "second escalation", at: "" },
        { role: "agent", name: "Claude", message: "routed", at: "", escalate: true },
      ],
    }],
  });
  const esc = collectEscalations(s);
  expect(esc.map((e) => e.round)).toEqual([1, 2]);
});

test("formatReviewSummary: open (unresolved) comments are tagged open", () => {
  const s = sidecar();
  s.rounds[0]!.comments[1]!.resolved = false;
  const out = formatReviewSummary(s);
  expect(out).toContain('"plain typo" — open');
});

test("formatReviewSummary: long messages are truncated with an ellipsis", () => {
  const s = sidecar();
  const long = "x".repeat(400);
  s.rounds[0]!.comments[1]!.thread[0]!.message = long;
  const out = formatReviewSummary(s);
  expect(out).not.toContain(long);
  expect(out).toContain("…");
});

test("formatReviewSummary: empty rounds are skipped", () => {
  const s = sidecar();
  s.rounds.push({
    round: 2,
    started_at: "", submitted_at: null, agent_replied_at: null, resolved_at: null,
    comments: [],
  });
  const out = formatReviewSummary(s);
  expect(out).not.toContain("Round 2");
});
