import { describe, expect, test } from "bun:test";
import { renderMarkdown, locateQuote } from "./render";

describe("renderMarkdown", () => {
  test("renders headings", () => {
    expect(renderMarkdown("# Hello\n")).toContain("<h1>Hello</h1>");
  });

  test("renders bold and italic", () => {
    const html = renderMarkdown("**bold** and *italic*");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });

  test("renders unordered lists", () => {
    const html = renderMarkdown("- one\n- two\n- three\n");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>three</li>");
  });

  test("renders fenced code blocks", () => {
    const html = renderMarkdown("```\nfoo\n```\n");
    expect(html).toContain("<code>");
    expect(html).toContain("foo");
  });

  test("renders GFM tables (gfm: true is set)", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });
});

describe("locateQuote", () => {
  test("finds the quote when it appears once", () => {
    expect(locateQuote("the quick brown fox", "quick", "")).toBe(4);
  });

  test("returns -1 when the quote is absent", () => {
    expect(locateQuote("the quick brown fox", "wolf", "")).toBe(-1);
  });

  test("uses context_before to disambiguate between duplicate occurrences", () => {
    const flat = "the cat sat. then the cat slept.";
    // First "cat" is at index 4, second is at index 22.
    // With "then the " as context, we should match the second.
    expect(locateQuote(flat, "cat", "then the ")).toBe(22);
    // With "the " as context, both match — indexOf returns the first.
    expect(locateQuote(flat, "cat", "the ")).toBe(4);
  });

  test("falls back to first occurrence when context-prefixed search fails", () => {
    const flat = "the cat sat. then the cat slept.";
    // Context that doesn't appear before the quote — fall back to first occurrence.
    expect(locateQuote(flat, "cat", "stale context that doesnt match: ")).toBe(4);
  });

  test("treats empty contextBefore as 'no context provided'", () => {
    expect(locateQuote("the cat sat", "cat", "")).toBe(4);
  });

  test("returns -1 for an empty quote", () => {
    expect(locateQuote("anything", "", "context")).toBe(-1);
  });

  test("handles quote at position 0", () => {
    expect(locateQuote("cat sat", "cat", "")).toBe(0);
  });

  test("context_before that ends right at the quote works correctly", () => {
    const flat = "A small trowel (ceremonial)";
    const ctx = "A small ";
    expect(locateQuote(flat, "trowel", ctx)).toBe(8);
  });
});
