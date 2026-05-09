import { test, expect } from "bun:test";
import { contextBlock } from "./contextBlock";
import { newEnvelope } from "./promptEnvelope";

test("returns empty string for missing context", () => {
  const env = newEnvelope();
  expect(contextBlock(undefined, env)).toBe("");
  expect(contextBlock(null, env)).toBe("");
});

test("returns empty string for blank-only context", () => {
  const env = newEnvelope();
  expect(contextBlock("", env)).toBe("");
  expect(contextBlock("   \n\t  ", env)).toBe("");
});

test("wraps real context in the envelope under a labelled section", () => {
  const env = newEnvelope();
  const out = contextBlock("Reviewing for technical accuracy, not prose.", env);
  expect(out).toContain("Reviewer's stated focus");
  expect(out).toContain("Reviewing for technical accuracy");
  // Wrapped via env.wrap("context", ...) — markers should bracket the text.
  expect(out).toContain(`<<UNTRUSTED-${env.uuid}-context-START>>`);
  expect(out).toContain(`<<UNTRUSTED-${env.uuid}-context-END>>`);
  // Trailing separator so the next prompt section starts cleanly.
  expect(out.endsWith("---\n\n")).toBe(true);
});

test("trims surrounding whitespace before wrapping", () => {
  const env = newEnvelope();
  const out = contextBlock("\n  focus on security  \n", env);
  expect(out).toContain("focus on security");
  expect(out).not.toContain("  focus on security  ");
});
