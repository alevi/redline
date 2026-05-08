import { test, expect } from "bun:test";
import { latestVerdict, type Comment } from "../src/sidecar";

function comment(thread: Comment["thread"]): Comment {
  return {
    id: "c1",
    quote: "q",
    context_before: "",
    context_after: "",
    thread,
    resolved: false,
  };
}

test("latestVerdict: no agent reply → null (treated as 'doesn't matter')", () => {
  expect(latestVerdict(comment([{ role: "human", message: "hi", at: "" }]))).toBeNull();
});

test("latestVerdict: agent reply without verdict field → null", () => {
  expect(latestVerdict(comment([
    { role: "human", message: "hi", at: "" },
    { role: "agent", message: "ack", at: "" },
  ]))).toBeNull();
});

test("latestVerdict: most recent agent verdict wins (re-classified after follow-up)", () => {
  expect(latestVerdict(comment([
    { role: "human", message: "fix typo", at: "" },
    { role: "agent", message: "will do", at: "", requires_revision: true },
    { role: "human", message: "actually never mind", at: "" },
    { role: "agent", message: "ok skipping", at: "", requires_revision: false },
  ]))).toBe("accept");
});

test("latestVerdict: returns 'revise' when latest agent says requires_revision: true", () => {
  expect(latestVerdict(comment([
    { role: "human", message: "rephrase this", at: "" },
    { role: "agent", message: "will do", at: "", requires_revision: true },
  ]))).toBe("revise");
});
