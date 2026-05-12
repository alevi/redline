import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

marked.setOptions({ gfm: true });

// Marked v9 dropped its built-in sanitizer and now passes raw HTML in markdown
// straight through to output. Without a post-render pass, a <script> tag, an
// <img onerror="...">, or a [link](javascript:alert(1)) in a reviewed document
// executes against the local API origin — read the doc, post comments (billing
// the user's Claude credits), trigger a revision overwrite. Defense is a
// sanitize-html pass over marked's output.
//
// Allowlist is the default markdown shape plus h1/h2/img/del/sup/sub. Code
// blocks need to keep their `language-*` class and the `data-language` attr
// render.ts attaches below for the syntax-tag CSS badge.
const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "blockquote", "hr", "br",
    "ul", "ol", "li",
    "a", "strong", "em", "del", "ins", "code", "pre", "sup", "sub",
    "img",
    "table", "thead", "tbody", "tr", "th", "td",
    "div", "span",
  ],
  allowedAttributes: {
    a: ["href", "title", "name"],
    img: ["src", "alt", "title", "width", "height"],
    code: ["class"],
    pre: ["data-language"],
    th: ["align"],
    td: ["align"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesAppliedToAttributes: ["href", "src"],
  allowProtocolRelative: false,
  // Marked emits `class="language-foo"` on <code> for syntax tagging; the
  // diff overlay (src/diff.ts wordDiffMarkdown) emits `<ins class="diff-word-add">`
  // and `<del class="diff-word-del">` for inline word-level edits. Anything
  // else gets stripped.
  allowedClasses: {
    code: [/^language-[\w-]+$/],
    ins: ["diff-word-add"],
    del: ["diff-word-del"],
  },
};

export function renderMarkdown(content: string): string {
  const dirty = marked.parse(content) as string;
  const clean = sanitizeHtml(dirty, SANITIZE_OPTS);
  // Surface the language tag on the <pre> so CSS can render a small badge.
  // Sanitizer keeps `language-foo` on the <code>; we re-derive the data-attr
  // on the <pre> here so it survives the sanitize pass.
  return clean.replace(
    /<pre><code class="language-([^"]+)">/g,
    '<pre data-language="$1"><code class="language-$1">'
  );
}

// Render a comment-thread message through the same sanitized markdown
// pipeline as the document body. Agents reply in markdown (bold, lists,
// inline code, occasional fenced blocks) and the chat-style rendering in
// the sidebar previously displayed the raw `**bold**` and `1.` syntax,
// which looked like the agent had failed to render its own output.
export function renderMessageMarkdown(content: string): string {
  return renderMarkdown(content);
}

/**
 * Locate where a quoted passage starts inside the flat text of a document.
 *
 * Returns the index in `flat` where the quote starts, or -1 if not found.
 *
 * Prefers a `contextBefore + quote` match so we can disambiguate between multiple
 * occurrences of the same quote. Falls back to the first occurrence of the quote
 * alone if the context-prefixed search fails (e.g. if the document was edited
 * such that the surrounding context shifted).
 */
export function locateQuote(
  flat: string,
  quote: string,
  contextBefore: string
): number {
  if (!quote) return -1;

  if (contextBefore) {
    const ctxIdx = flat.indexOf(contextBefore + quote);
    if (ctxIdx !== -1) return ctxIdx + contextBefore.length;
  }

  return flat.indexOf(quote);
}
