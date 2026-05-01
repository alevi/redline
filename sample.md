# Sample Document

This is a sample document. Use it to test Redlines selection and commenting workflow on real Markdown content. You can select any text on this page and leave an inline comment. Some text is *italic*, some is **bold**, and some is ***both***. There's also ~~strikethrough~~ for things we considered and rejected.

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

| Component | Status | Owner |
|-----------|--------|-------|
| Reader | Done | Alon |
| Sidecar | Done | Alon |
| Agent loop | In progress | Claude |
| Typed actions | Planned | — |

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


---

## Settled comments

1. Quote: "sample document for testing"
   Discussion:
    Reviewer: Replace this entire opening sentence with: This is a sample document. Use it to test Redlines selection and commenting workflow on real Markdown content.

---

## Previously agreed changes (do not undo)

- Round 1: "sample document for testing" → This looks like a test comment on the opening phrase. Are you testing the Redline workflow, or would you like me to revise "sample document for testing" to something more specific?
- Round 1: "A subsection (H3)" → This is a test comment flagging the H3 heading. If you'd like me to revise the heading text, make it more descriptive, or adjust its level in the hierarchy, let me know what change you'd prefer.
- Round 1: "function greet" → Got it — you've flagged the `greet` function. Would you like me to adjust this code (e.g., add error handling, change the syntax, or expand the example), or is this just testing that comments work on code blocks?
- Round 1: "agent will always" → This assumption is indeed worth questioning—in practice, agents sometimes produce malformed Markdown or introduce subtle formatting issues. Would you like me to revise this to acknowledge potential agent errors and suggest a validation or correction step? Or is this flagged because the language is too absolute?
- Round 1: "multiple sentences that should be" → Got it — this looks like a test comment to verify the anchor lands correctly on that phrase. No change needed to the document text; the selection and threading are working as expected.
- Round 1: "Top level item" → This appears to be a test comment on the first list item. Is this testing the comment system itself, or would you like me to revise the "Top level item" text or its context in the list?
- Round 1: "Nested item" → I see the test comment on "Nested item" — looks like you're verifying the comment capture works. What would you like me to do with this passage? Should I reword it, expand the nested list section, or is this just a system check?
- Round 1: "Deeply nested item" → This appears to be a test comment on the deeply nested list item. Is this confirming that the selection mechanism works correctly for nested content, or would you like me to make a change to that text?
- Round 1: "Set up the server" → I see this is a test comment on the task list item. The current text "Set up the server" is marked complete (`[x]`). If you want me to revise this section—like expanding what setup entails, rephrasing it, or restructuring the task list—just let me know what change you're looking for.
- Round 1: "Render markdown" → This comment is unclear — does "stacking-test" indicate this is a placeholder, or are you asking me to verify/improve something about how Markdown renders? If you could clarify what you'd like changed, I can address it in the revision.