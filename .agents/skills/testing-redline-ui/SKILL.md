---
name: testing-redline-ui
description: End-to-end test the Redline review UI. Use when verifying client-side changes (CSS, JS/TS modules, comment flow, SSE, round state).
---

# Testing Redline UI

## Prerequisites

- Bun installed (`curl -fsSL https://bun.sh/install | bash`)
- Dependencies installed (`bun install` in repo root)
- Claude CLI on PATH (see workaround below if not available)

## Agent Stub Workaround

Redline requires `claude` CLI on PATH (`preflightClaudeCli()` in `src/cli.ts`). If the real CLI isn't installed, create a dummy:

```bash
echo '#!/bin/bash\necho "dummy claude"' > ~/.bun/bin/claude && chmod +x ~/.bun/bin/claude
```

This allows the server to start and the UI to render. Agent replies will echo "dummy claude" — sufficient for testing UI rendering, state management, and card lifecycle. The agent integration path itself won't be tested.

## Running the Server

```bash
# Create a test markdown file with sections, tables, code blocks
cat > test-doc.md << 'EOF'
# Sample Review Document

This is a test document.

## Section One

The quick brown fox jumps over the lazy dog. This sentence contains enough text to allow meaningful text selection.

## Section Two

| Column A | Column B |
|----------|----------|
| Cell 1   | Cell 2   |

Tables test the cell-boundary clamping logic.

## Section Three

```javascript
function hello() {
  console.log("Hello, world!");
}
```

Code blocks test syntax highlighting via hljs.
EOF

# Start the server
bun run src/cli.ts test-doc.md
```

The server prints the URL (usually `http://localhost:PORT`).

## Test Flow Sequence

Execute in this order for maximum coverage:

1. **CSS loading** — Verify two-column layout, styled header with Round badge, prose area styling
2. **Syntax highlighting** — Check code block has hljs coloring (keywords, strings)
3. **Text selection → comment form** — Drag to select text within a single paragraph (cross-section selections are intentionally rejected with an error banner)
4. **Save comment → card rendering** — Type a comment and save; verify card with quoted text, thread, highlight, nav counter
5. **Reply form toggle** — Click Reply on a card; verify inline textarea opens
6. **Add second comment** — Select text in a different section for navigation testing
7. **Navigation** — Use Prev/Next buttons in nav bar; verify counter updates and active card changes
8. **Resolve** — Click "Resolve → queue edit"; verify card collapses with Resolved badge, nav count decreases
9. **Reopen** — Click resolved card to expand, click Reopen; verify card restores, nav count increases
10. **Round state** — Resolve all comments; verify "Revise document" button enables and banner shows "ready to revise"
11. **Console check** — Open DevTools Console; only `favicon.ico` 404 is expected (browser-generated)

## Important Notes

- Text selections that cross section boundaries are intentionally rejected — this is correct behavior from `selection.ts`
- The `showError` function displays a red banner at the bottom that auto-dismisses
- Cards position themselves adjacent to their highlight in the prose area via `positionCards()`
- The dummy agent always returns "edit queued" verdict, so all resolved comments will show the "Revise document" flow (not "Accept doc")
- SSE connection may show reconnect attempts in the Network tab — this is normal zombie-SSE recovery behavior from `sse.ts`
