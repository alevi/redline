import { marked } from "marked";

marked.setOptions({ gfm: true });

export function renderMarkdown(content: string): string {
  const html = marked.parse(content) as string;
  // Surface the language tag on the <pre> so CSS can render a small badge.
  // Marked emits <pre><code class="language-foo">...</code></pre>.
  return html.replace(
    /<pre><code class="language-([^"]+)">/g,
    '<pre data-language="$1"><code class="language-$1">'
  );
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
