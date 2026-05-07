# Redline

A local tool for leaving inline comments on Markdown files so an AI agent can act on them.

## What it is

Redline is a single-player Markdown review tool. You point it at a `.md` file, it opens a browser-based reader where you can select text and leave inline comments, and it saves those comments to a sidecar file. You then hand the file + sidecar to an AI agent (Claude, Codex, etc.) and it addresses your comments and revises the document.

**The one-liner:** Google Docs-style inline comments for Markdown files, designed for human-in-the-loop AI doc review.

## What it is not

- Not a Markdown editor
- Not a collaboration tool (single-player for now)
- Not a knowledge base or publishing platform
- Not AI-first — the human reviews, the agent responds

## Core workflow

1. Agent produces a `.md` file (a spec, brief, RFC, plan, etc.)
2. `redline spec.md` opens a local browser reader
3. You select text → leave a comment → save
4. Comments saved to `.review/spec.md.json` (sidecar, gitignore-able)
5. Agent reads the original file + sidecar, addresses each comment, produces revised doc

## Architecture

### Two pieces

**1. The Review Reader** — local web server, renders Markdown beautifully, select-to-comment UI, saves sidecar

**2. The Agent Handoff** — prompt convention / CLI command that feeds (document + comments) to an agent

### Sidecar format — `.review/<filename>.json`

```json
{
  "file": "spec.md",
  "reviewed_at": "2026-04-29T10:00:00Z",
  "comments": [
    {
      "id": "c1",
      "quote": "the exact selected text",
      "context_before": "32 chars before the quote",
      "context_after": "32 chars after the quote",
      "comment": "This assumption doesn't hold if the user is offline",
      "resolved": false,
      "created_at": "2026-04-29T10:05:00Z"
    }
  ]
}
```

### CLI shape

```
redline spec.md          # opens reader at localhost:3000
redline resolve spec.md  # runs agent handoff (prints prompt or calls agent)
```

## Design decisions

- **Free text comments first.** Typed actions (`[expand]`, `[challenge]`, `[cut]`) come later, after real usage reveals the natural taxonomy.
- **Sidecar in `.review/` folder.** Next to the file, gitignore-able as a pattern, obvious where to look.
- **No anchoring-under-external-edits problem.** The file isn't edited while you're reviewing it. Agent writes, you comment, agent revises. Quote + context_before + context_after is enough to relocate a comment if you reopen the review.
- **Comments are instructions, not just notes.** The sidecar is structured so an agent can read and act on it in one pass.

## What to build first

1. Local web server (Node/Bun) that watches a file and renders it
2. Select-to-comment UI (plain JS, no framework needed at first)
3. Sidecar save/load
4. Agent handoff prompt template
5. Basic CLI wrapper (`redline <file>`)

## Future / explicit non-goals for now

- Typed comment actions — add after real usage
- Revision rounds (tracking comment → agent response → sign-off) — add after v1
- Multiplayer / sharing — separate product (Markdown Review Room)
- GitHub integration
- Auth
- Persistent history across revisions

## Relationship to Markdown Review Room

Redline is the single-player, local, agent-focused version. Markdown Review Room is the broader vision: a collaborative review layer for Markdown files shared with non-technical stakeholders. Redline proves the sidecar architecture and the review workflow. If it works and people want to share their review links, that's when the larger product makes sense.

## Stack (undecided, notes)

- Runtime: Bun or Node
- Server: lightweight (Hono, Fastify, or just http)
- UI: plain JS or minimal framework — avoid over-engineering
- Markdown rendering: remark + rehype pipeline
- Syntax highlighting: shiki or highlight.js
- Comment storage: local JSON (sidecar)

## Implementation as built

- Runtime: Bun. Server: Hono. Markdown: marked. Frontend: plain JS in `src/client/main.js`, bundled at server startup via `Bun.build` and served at `/client.js`. Pure helpers (`escapeHtml`, `latestVerdict`, `nearestCell`, `clampRangeToCell`, `captureSelection`, `highlightText`, `computeNavState`, `preserveScroll`) live in [src/client/lib.ts](src/client/lib.ts) with happy-dom test coverage in [src/client/lib.test.ts](src/client/lib.test.ts).
- `src/cli.ts` dispatches: bare arg = open reader; `resolve <file>` = run agent revision. The bare-arg path also spawns a dedicated agent subprocess (see below).
- `src/resolve.ts` and `src/agent.ts` both shell out to the `claude -p` CLI rather than calling the Anthropic SDK — this way the user never needs `ANTHROPIC_API_KEY` set; auth comes from their existing Claude Code session. If you are tempted to switch to the SDK, don't — that was the path that failed.
- Sidecar shape evolved past the design doc: it now has `rounds[]`, each with `submitted_at` / `agent_replied_at` / `resolved_at` and a `comments[]` where each comment has a `thread[]` of `{ role: human|agent, name?, message, at }`. See [src/sidecar.ts](src/sidecar.ts).
- History: every `resolve` snapshots the pre-revision file to `.review/history/<file>.<iso>.md` so past rounds can be viewed read-only at `/round/:n`.

## The dedicated agent process

`redline <file>` spawns `src/agent.ts` as a child process alongside the server. The agent opens its own SSE connection to `/api/events` and reacts to comment events directly, with no Claude Code task-notification overhead.

- Reply latency is bounded by Haiku/Sonnet inference (~1–3s) instead of by task scheduling (~5–15s).
- The agent's read loop **does not await** event handlers — it fires them and continues reading. This lets multiple comments process in parallel, and prevents a slow response from blocking the SSE stream and missing later events.
- An `inProgress` Set deduplicates so the same comment isn't replied to twice if `comment-reply` fires multiply.
- `agent-replied` is fired only when `inProgress` drains to zero, so the UI sees one "agent done" event per batch rather than per reply.
- The CLI installs `exit`/`SIGINT`/`SIGTERM` handlers to kill the agent when the server dies.

## Model picking

Both `agent.ts` (replies) and `resolve.ts` (revisions) pick a model based on the human's message text:

- Default to Haiku (`claude-haiku-4-5-20251001`) for short confirmations and simple substitutions.
- Promote to Sonnet (`claude-sonnet-4-6`) when the message is long (>120 chars for replies, >150 for revisions), contains a question mark, or matches an "involved" keyword (`suggest`, `alternative`, `rewrite`, `restructure`, `tone`, etc.).
- `redline resolve --model <id>` overrides the picker for a one-off run.

The chosen model is logged so you can see which path each event took.

## Workflow model (important)

The original design doc had a "Submit for review" button. **That is gone.** The current model:

1. Human leaves a comment → server broadcasts `comment-added` SSE event → agent replies immediately.
2. Human can reply in the thread → broadcasts `comment-reply` → agent replies again.
3. Human resolves comments one by one. When all are resolved, the round-level button enables — labelled by the **majority verdict** the agent attached to its replies (see "Verdict-aware resolve" below). Default is "Revise document"; if every comment was answered without implying an edit, the default flips to "Accept as-is" (calls `/api/finish`, no revision pass). The non-default action is always one click away as a small secondary link below.
4. Human clicks Revise → broadcasts `accepted` → agent runs the resolve flow → `/api/reload` triggers full browser reload to the next round.
5. When a round opens with no comments to act on, the same button reads "Done" and calls `/api/finish`. That broadcasts `finished`, the browser shows a "review complete" splash, and the server prints a summary and exits — handing control back to whichever terminal launched it.

The conversation is real-time. There is no "notify the agent" step. If you reintroduce one, you are reverting a UX decision that was already made and tested.

The button is intentionally **not** styled green. It triggers a non-trivial revision pass, not a final confirmation — neutral styling reflects that.

## SSE event vocabulary

| Event | Fired when | Client behavior |
|---|---|---|
| `comment-added` | Human posts a new comment | Soft refresh + `applyHighlights()` (new highlight needed) |
| `comment-reply` | Human or agent posts to existing thread | Soft refresh; remove that comment from `thinkingCommentIds` |
| `comment-resolved` | Human resolves a comment | Soft refresh + `applyHighlights()` (color change) |
| `comment-thinking` | Agent POSTs `/api/comment/:id/thinking` | Add to `thinkingCommentIds`, show dots in that thread (multiple threads can be active simultaneously) |
| `agent-replied` | Agent POSTs `/api/agent-replied` after all in-flight replies finish | Clear `thinkingCommentIds`, soft refresh |
| `accepted` | Human clicks "Revise document" | Agent's cue to run the resolve flow |
| `finished` | Human clicks "Done" on a round with no comments, or "Looks good — close session" in the diff overlay | Replace body with a "Review complete — close this tab" splash |
| `reload` | The resolve flow finishes writing the revised document | Full `window.location.reload()` |

Soft refresh = `GET /api/comments` then re-render the sidebar. Full reload = `window.location.reload()`. **Use soft refresh for everything except `reload`.** Full reloads scroll to top and feel jarring.

The server sends `: ping\n\n` comment frames every 15 seconds to keep the SSE connection alive through long revisions. Without this the browser would silently disconnect during a 60s+ Sonnet pass and miss the `reload` event when it finally fired.

## Frontend gotchas (paid in blood)

- **Never call `window.location.reload()` for routine UI updates.** It loses scroll position and feels like a page navigation. Soft-refresh via `softRefresh()` for comment events.
- **DOM rebuilds inside scrollable content can scroll the page to 0.** Two distinct causes:
  1. `prose.normalize()` + re-wrapping text in `<mark>` shifts layout briefly.
  2. Destroying a focused `<textarea>` (e.g. when `renderComments()` rebuilds the sidebar after a reply submit) makes the browser scroll the focus target into view, which can land at the document top.
- The fix is the `preserveScroll(fn)` wrapper in [src/server.ts](src/server.ts). It saves `scrollY`, calls `.blur()` on the active element first, runs the mutation, then sets `scrollTop` synchronously **and** across two `requestAnimationFrame` callbacks. The triple restore is not paranoia — focus-related scroll lands a frame later.
- Wrap any function that mutates significant DOM with `preserveScroll`. Right now that's `applyHighlights` and `renderComments`.
- `applyHighlights` is expensive (full prose rewrite). Only call it when highlights actually change: new comment, resolved/unresolved. **Do not call it on reply.** This is why `softRefresh` takes `{ rehighlight: true }`.

## Server lifecycle

There is no auto-restart. After editing `src/server.ts` or `src/agent.ts` you must:

```
pkill -f "agent.ts" 2>/dev/null; lsof -ti:3000 | xargs kill -9 2>/dev/null; /Users/alonlevi/.bun/bin/bun run src/cli.ts <file.md> &
```

(The CLI also kills the agent on its own SIGINT/SIGTERM, but if you only edited `agent.ts` you can restart just the agent: `pkill -f "agent.ts" && bun src/agent.ts <absolute-path-to-file.md> &`.)

The browser SSE EventSource auto-reconnects (3s backoff), so the open tab survives a restart — but you still need to hard-reload (Cmd+Shift+R) to pick up new client-side JS.

On startup the server checks the sidecar and auto-creates an open round if all rounds are resolved. This prevents a stuck "Revising the document" spinner state when reopening a previously-finished review.

## Agent etiquette inside the conversation flow

When you're acting as the agent on the other end of the SSE stream:

1. POST `/api/comment/:id/thinking` *before* you start composing. This is the user's only signal that you saw their message.
2. POST `/api/comment/:id/reply` with `{ role: "agent", name: "Claude", message, requires_revision, revision_reason }`. The verdict fields are required of every agent reply — see "Verdict-aware resolve" below.
3. POST `/api/agent-replied` to clear the thinking indicator and trigger soft-refresh.

Skipping step 1 leaves the user staring at silence wondering if anything is happening.

## Verdict-aware resolve (M5_P1)

Every agent reply ships with a verdict on whether the comment, once resolved, implies an edit to the document. The fields live on the `ThreadEntry` for that agent reply:

- `requires_revision: true` — the comment implies a doc edit (typo fix, rewording, restructure, content change). The per-comment Resolve button reads "Resolve → queue edit" and tints warm. The resolved card carries an "✎ Edit queued" badge.
- `requires_revision: false` — the conversation answered it (clarifying question, approval, agent explanation that doesn't imply an edit). The Resolve button stays plain, the card carries a "✓ Answered" badge.
- field absent — the comment was resolved before the agent ever replied. Treated as `accept` (the human resolved unilaterally, so they're saying "doesn't matter").

The round-level button picks its default by the latest verdict on each comment:
- All verdicts are `accept` → primary = **Accept as-is** (`/api/finish`, no revision pass)
- Any verdict is `revise` → primary = **Revise document** (`/api/accept`)
- The non-default action is always available as a secondary text link under the banner. Choosing "accept anyway" when comments imply edits triggers a `confirm()` warning.

The agent CLI (`src/agent.ts`) gets the verdict by switching `claude -p` from free-text to a JSON contract: `{ "message": "…", "requires_revision": true|false, "reason": "one short sentence" }`. `src/parseReply.ts` parses it; on any parse failure it falls back to `{ requires_revision: true }` (safe default — better to run an unnecessary revision than silently skip an implied edit).

The verdict is **agent-owned**. The human cannot flip it directly. Disagreement flows through a follow-up reply, which gives the agent a chance to re-classify rather than be silently overridden.
