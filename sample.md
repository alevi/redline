# Sample Document

This is a sample document. Use it to test Redlines selection and commenting workflow on real Markdown content. You can select any text on this page and leave an inline comment. Some text is _italic_, some is **bold**, and some is **_both_**. There's also ~~strikethrough~~ for things we considered and rejected.

Visit the [Redline repo](https://github.com/alevi/redline) for the source.

## Why this matters

Inline comments are a natural way to give feedback on a document. Instead of writing "on line 3, the second sentence..." you just select the text and comment on it directly.

### A subsection (H3)

Specs typically nest. This is an H3 heading.

#### And one level deeper (H4)

H4 is rarer but worth styling.

## How to use

1. Select some text in this document
2. A comment form opens in the right rail
3. Type your comment and press **Save** (or Cmd+Enter)
4. When all comments are resolved, click **Revise document** — or **Done** to close without revising

### Nested list

- Top level item
  - Nested item
    - Deeply nested item
- Back to top level
- With a [link inside](https://example.com)

### Task list

- [x] Set up the server
- [x] Render markdown
- [ ] Add inline comments
- [ ] Wire up agent replies

## A section with code

Here's an example of a fenced code block with a language:

```typescript
function greet(name: string): string {
  return `Hello, ${name}!`;
}
```

A code block without a language:

```
plain text in a code block
no syntax highlighting expected
```

And some inline `code` too.

## A table

| Component     | Status      | Owner  |
| ------------- | ----------- | ------ |
| Reader        | Done        | Alon   |
| Sidecar       | Done        | Alon   |
| Agent loop    | In progress | Claude |
| Typed actions | Planned     | —      |

## Images

A real image via data URL (should render):

![A small red square](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4MCIgaGVpZ2h0PSI4MCI+PHJlY3Qgd2lkdGg9IjgwIiBoZWlnaHQ9IjgwIiBmaWxsPSIjYzAzOTJiIi8+PC9zdmc+)

A relative path that the server won't currently serve (tests 404 behavior):

![Architecture diagram](./diagram.png)

A broken external URL (tests broken-image state):

![Should not load](https://nope.invalid/missing.png)

---

## Assumptions worth questioning

- The agent will always produce a valid Markdown file
- A single round of review is enough for most documents
- The sidecar file is sufficient context for the agent to act
- Network conditions are good enough that SSE streams stay alive
- The reviewer is at a desk with a real keyboard, not on mobile

## A blockquote

> This is a blockquote. Select it and leave a comment to test that selection works inside blockquotes.
>
> Multi-paragraph blockquotes should also render — the second paragraph here is part of the same quote.

## A long paragraph

This paragraph exists to give the polish reviewer something substantial to highlight. It contains multiple sentences that should be selectable across boundaries. Selection that crosses a sentence boundary, or that includes punctuation, or that picks up trailing whitespace — all of these should produce a sensible comment anchor. The reviewer might also test selecting from the start of this paragraph all the way to the end, or just a single word in the middle, or a span that includes the inline `code` from earlier sections by reference.

## Hard line breaks

Line one with two trailing spaces.  
Line two should appear directly under it.

## Final thoughts

Redline is intentionally minimal. It does one thing: let you leave inline comments on a Markdown file so an AI agent can act on them.
