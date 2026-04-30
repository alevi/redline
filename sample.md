# Sample Document

This is a sample document for testing Redline. You can select any text on this page and leave an inline comment.

## Why this matters

Inline comments are a natural way to give feedback on a document. Instead of writing "on line 3, the second sentence..." you just select the text and comment on it directly.

## How to use

1. Select some text in this document
2. Click **Add comment** in the tooltip that appears
3. Type your comment and press **Save** (or Cmd+Enter)
4. When you're done reviewing, click **Done reviewing**

## A section with code

Here's an example of a fenced code block:

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

And some inline \`code\` too.

## Assumptions worth questioning

- The agent will always produce a valid Markdown file
- A single round of review is enough for most documents
- The sidecar file is sufficient context for the agent to act

> This is a blockquote. Select it and leave a comment to test that selection works inside blockquotes.

## Final thoughts

Redline is intentionally minimal. It does one thing: let you leave inline comments on a Markdown file so an AI agent can act on them.
