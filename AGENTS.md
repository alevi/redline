# Redline — agent onboarding

This file orients an AI agent contributing to the Redline codebase. It captures the architecture, the load-bearing implementation decisions, and the non-obvious gotchas that have bitten previous changes. For product framing (what Redline is, who it's for, how to use it), see [README.md](README.md).

## What you're working in

Redline is a single-player, local Markdown review tool. The user points it at a `.md` file; it opens a browser-based reader; the user leaves inline comments; an agent process replies in real time; the user resolves and accepts; the document is revised. The two pieces are:

1. **The Review Reader** — local Bun + Hono server, renders Markdown, serves a small client-side JS app, handles select-to-comment, persists comments to a sidecar.
2. **The conversational agent** — a child process spawned alongside the server that listens to comment events and replies via the selected local agent provider (`claude` or `codex`).

The product is real-time conversation, not turn-based submit/respond. Reviews can span multiple rounds (comment → reply → resolve → revise → next round) until the user signs off.

## Architecture

### Sidecar — `.review/<filename>.json`

The sidecar is the source of truth for a review session. Schema lives in [src/sidecar.ts](src/sidecar.ts):

```ts
Sidecar { file, context?, rounds: Round[] }
Round   { round, started_at, submitted_at, agent_replied_at, resolved_at, comments: Comment[] }
Comment { id, quote, context_before, context_after, thread: ThreadEntry[], resolved }
ThreadEntry { role: human|agent, name?, message, at, requires_revision?, revision_reason? }
```

- **Per-file mutex.** `withSidecar(filePath, fn)` in [src/sidecar.ts](src/sidecar.ts) holds a per-file lock across `load → mutate → save` so concurrent POSTs can't interleave and silently drop a writer's mutation. Use it for every endpoint that touches the sidecar.
- **History.** Every `resolve` snapshots the pre-revision file to `.review/history/<file>.<iso>.md`. Past rounds are viewable read-only at `/round/:n`.

### CLI shape

```
redline <file>                 # opens the review reader; URL is printed and written to .review/<file>.startup.json
redline <file> --context "..." # opens with a reviewer-supplied focus statement (see "Context-aware prompts" below)
redline <file> --agent codex   # use Codex instead of the auto-detected/default provider
redline <file> --no-agent      # manual annotation mode — no agent spawn, no provider CLI required on PATH
redline resolve <file>         # one-shot: read the sidecar, run the revision pass, write back
redline author-needed <file>   # list comments where the inline agent requested author input
redline author-reply <file> <comment-id> --message "..." # post an author-marked reply into the thread
redline author-wait <file>     # block until author input is needed or the review result is written
```

The bare-arg path also spawns a dedicated agent subprocess alongside the server — see "The dedicated agent process" below.

### Context-aware prompts

When the user passes `--context "..."` (or the sidecar already has `context` set from a prior run), the string is rendered above the doc as a banner *and* prepended to both prompt builders:

- [src/agent.ts](src/agent.ts) calls `loadSidecar` per reply and prepends a `Reviewer's stated focus` block to the user message before the document/comment sections.
- [src/resolve.ts](src/resolve.ts) prepends the same block to the revision user message.

The shared helper is [src/contextBlock.ts](src/contextBlock.ts) — a one-liner that returns either the formatted block or empty string. It wraps the context through the same UUID-anchored envelope as the document and comment text, so adversarial context content can't escape its envelope to pose as system instructions.

### Frontend

Client-side JS lives in [src/client/main.ts](src/client/main.ts). It is bundled at server startup via `Bun.build` and served from memory at `/client.js`. Pure helpers (`escapeHtml`, `latestVerdict`, `nearestCell`, `clampRangeToCell`, `captureSelection`, `highlightText`, `computeNavState`, `preserveScroll`) live in [src/client/lib.ts](src/client/lib.ts) with happy-dom test coverage in [src/client/lib.test.ts](src/client/lib.test.ts). New pure logic should land in `lib.ts` with tests.

Server-side state is bootstrapped into the page as `window.__REDLINE__` ahead of the bundle.

### Inline diff toggle

After a revision pass, the new round opens with the document rendered **as the diff** (block-level insert/delete bands, word-level `<ins>`/`<del>` marks for modified paragraphs). A header toggle (`#btn-toggle-diff`, "Show changes" / "Hide changes") flips between diff view and clean view. The toggle is only rendered on rounds 2+ in the live view — round 1 has nothing to compare against, and the read-only `/round/:n` views can't use `/api/diff` honestly because that endpoint always compares the current file to the most recent snapshot.

- Pure swap helpers (`applyDiffSwap`, `revertDiffSwap`, `updateToggleButton`, `diffStateKey`) live in [src/client/diffToggle.ts](src/client/diffToggle.ts) with tests in [src/client/diffToggle.test.ts](src/client/diffToggle.test.ts). DOM + network glue is in [src/client/diff.ts](src/client/diff.ts).
- Diff HTML is fetched lazily from `/api/diff` and cached in-module; the original clean innerHTML is captured on the first swap so toggling back is a pure restore (no second fetch, no server round trip).
- Per-file state is persisted in `sessionStorage` under `rl-diff-on-<title>` so soft refreshes don't reset the view. Auto-enabled on round open when `just-revised` is set.
- After every swap, both `applyHighlights()` and `renderComments()` re-run because the prose DOM was rebuilt and comment marks/cards need to re-anchor.
- Commenting stays enabled in diff mode. Quotes captured against diff text may include `<ins>`/`<del>` boundaries; flipping back to clean view can fail to highlight those comments. Accepted tradeoff.

## Design decisions worth knowing

- **Free-text comments only.** Typed actions (`[expand]`, `[challenge]`, `[cut]`) are a future direction; don't add structure prematurely.
- **Sidecar lives next to the file, in `.review/`.** Gitignore-able as a pattern, obvious where to look. Don't move it.
- **No anchoring-under-edits problem.** The agent doesn't edit the file while the user is reviewing — write happens between rounds. Quote + 32 chars before/after is enough to relocate a comment when reopening a review.
- **Comments are instructions, not just notes.** The sidecar is structured so an agent can read and act on it in one pass.
- **Shell out to local agent CLIs, don't use SDKs.** Both `src/agent.ts` (replies) and `src/resolve.ts` (revisions) invoke the selected provider through [src/agentProvider.ts](src/agentProvider.ts), so auth comes from the user's existing Claude Code or Codex session. Do not switch Redline to SDK/API-key auth without a deliberate product decision.

## The dedicated agent process

`redline <file>` spawns [src/agent.ts](src/agent.ts) as a child process alongside the server. The agent opens its own SSE connection to `/api/events` and reacts to comment events directly, with no harness-level task-notification overhead.

- Reply latency is bounded by the selected provider's inference time instead of by task scheduling.
- The agent's read loop **does not await** event handlers — it fires them and continues reading. This lets multiple comments process in parallel and prevents a slow response from blocking the SSE stream.
- An `inProgress` Set deduplicates so the same comment isn't replied to twice if `comment-reply` fires multiply.
- `agent-replied` is fired only when `inProgress` drains to zero, so the UI sees one "agent done" event per batch rather than per reply.
- The CLI installs `exit`/`SIGINT`/`SIGTERM` handlers to kill the agent when the server dies, and auto-restarts the agent on unexpected exit (capped to 5 restarts per 60s window — see [src/cli.ts](src/cli.ts)).

### `--no-agent` (manual mode)

Skips provider preflight and the agent spawn. The server still serves the page, accepts comments, and resolves them; there's just no agent to reply or revise. The page bootstraps `noAgent: true` into `window.__REDLINE__` and shows a "Manual mode" pill in the header. The client uses the flag to:

- Force the round-level button into **finish** mode (`/api/finish`) regardless of comment count, since `/api/accept` would dead-end on the watchdog with no agent to land `/api/reload`.
- Suppress the "revise the document anyway" secondary link for the same reason.

Per-comment verdict logic degrades naturally: with no agent there are no `requires_revision` fields, and the existing fallback ("field absent → treated as accept") makes "Accept as-is" the natural finish path.

## Model picking

Both `agent.ts` (replies) and `resolve.ts` (revisions) pick a model tier based on the human's message text:

- Default to `fast` for short confirmations and simple substitutions.
- Promote to `smart` when the message is long (>120 chars for replies, >150 for revisions), contains a question mark, or matches an "involved" keyword (`suggest`, `alternative`, `rewrite`, `restructure`, `tone`, etc.).
- The provider maps tiers to concrete model ids. `redline resolve --model <id>` overrides the picker for a one-off run.

The chosen model is logged so you can see which path each event took. See [src/pickModel.ts](src/pickModel.ts).

## Workflow model

The conversation is real-time. There is no "submit for review" step. The flow:

1. Human leaves a comment → server broadcasts `comment-added` SSE event → agent replies immediately.
2. Human can reply in the thread → broadcasts `comment-reply` → agent replies again.
3. Human resolves comments one by one. When all are resolved, the round-level button enables — labeled by the **majority verdict** the agent attached to its replies (see "Verdict-aware resolve" below). Default is "Revise document"; if every comment was answered without implying an edit, the default flips to "Accept as-is" (calls `/api/finish`, no revision pass). The non-default action is always one click away as a small secondary link below.
4. Human clicks Revise → broadcasts `accepted` → agent runs the resolve flow → `/api/reload` triggers a full browser reload to the next round.
5. When a round opens with no comments to act on, the same button reads "Done" and calls `/api/finish`. That broadcasts `finished`, the browser shows a "review complete" splash, and the server prints a summary and exits — handing control back to whichever terminal launched it.

The Revise button is intentionally **not** styled green. It triggers a non-trivial revision pass, not a final confirmation; neutral styling reflects that.

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
| `agent-unavailable` | CLI hits the agent restart cap (5 in 60s) | Show persistent "Agent offline" pill in header; sticky until page reload |

Soft refresh = `GET /api/comments` then re-render the sidebar. Full reload = `window.location.reload()`. **Use soft refresh for everything except `reload`.** Full reloads scroll to top and feel jarring.

The server sends `: ping\n\n` comment frames every 15 seconds to keep the SSE connection alive through long revisions. Without this the browser would silently disconnect during a long revision pass and miss the `reload` event when it finally fired.

## Frontend gotchas (paid in blood)

- **Never call `window.location.reload()` for routine UI updates.** It loses scroll position and feels like a page navigation. Soft-refresh via `softRefresh()` for comment events.
- **DOM rebuilds inside scrollable content can scroll the page to 0.** Two distinct causes:
  1. `prose.normalize()` + re-wrapping text in `<mark>` shifts layout briefly.
  2. Destroying a focused `<textarea>` (e.g. when `renderComments()` rebuilds the sidebar after a reply submit) makes the browser scroll the focus target into view, which can land at the document top.
- The fix is the `preserveScroll(fn)` wrapper in [src/client/lib.ts](src/client/lib.ts). It saves `scrollY`, calls `.blur()` on the active element first, runs the mutation, then sets `scrollTop` synchronously **and** across two `requestAnimationFrame` callbacks. The triple restore is not paranoia — focus-related scroll lands a frame later.
- Wrap any function that mutates significant DOM with `preserveScroll`. Right now that's `applyHighlights` and `renderComments`.
- `applyHighlights` is expensive (full prose rewrite). Only call it when highlights actually change: new comment, resolved/unresolved. **Do not call it on reply.** This is why `softRefresh` takes `{ rehighlight: true }`.

## Server lifecycle

There is no auto-restart. The server binds to an OS-assigned port (`port: 0`, hostname `127.0.0.1`) so you can't kill it by port number — kill the CLI process. After editing `src/server.ts` or `src/agent.ts`:

```bash
pkill -f "src/cli.ts" 2>/dev/null
pkill -f "src/agent.ts" 2>/dev/null
bun run src/cli.ts <file.md> &
```

(The CLI also kills the agent on its own SIGINT/SIGTERM, but if you only edited `agent.ts` you can restart just the agent: `pkill -f "src/agent.ts" && REDLINE_PORT=<port> REDLINE_TOKEN=<token> bun src/agent.ts <absolute-path-to-file.md> &` — port and token come from the printed startup URL and `.review/<file>.startup.json`.)

The browser SSE EventSource auto-reconnects (3s backoff), so the open tab survives a restart — but you still need to hard-reload (Cmd+Shift+R) to pick up new client-side JS.

On startup the server checks the sidecar and auto-creates an open round if all rounds are resolved. This prevents a stuck "Revising the document" spinner state when reopening a previously-finished review.

## Agent etiquette inside the conversation flow

When you're acting as the agent on the other end of the SSE stream:

1. POST `/api/comment/:id/thinking` *before* you start composing. This is the user's only signal that you saw their message.
2. POST `/api/comment/:id/reply` with `{ role: "agent", name: "<provider display name>", message, requires_revision, revision_reason }`. The verdict fields are required of every agent reply — see "Verdict-aware resolve" below.
3. POST `/api/agent-replied` to clear the thinking indicator and trigger a soft refresh.

Skipping step 1 leaves the user staring at silence wondering if anything is happening.

## Verdict-aware resolve

Every agent reply ships with a verdict on whether the comment, once resolved, implies an edit to the document. The fields live on the `ThreadEntry` for that agent reply:

- `requires_revision: true` — the comment implies a doc edit (typo fix, rewording, restructure, content change). The per-comment Resolve button reads "Resolve → queue edit" and tints warm. The resolved card carries an "✎ Edit queued" badge.
- `requires_revision: false` — the conversation answered it (clarifying question, approval, agent explanation that doesn't imply an edit). The Resolve button stays plain, the card carries a "✓ Answered" badge.
- field absent — the comment was resolved before the agent ever replied. Treated as `accept` (the human resolved unilaterally, so they're saying "doesn't matter").

The round-level button picks its default by the latest verdict on each comment:

- All verdicts are `accept` → primary = **Accept as-is** (`/api/finish`, no revision pass).
- Any verdict is `revise` → primary = **Revise document** (`/api/accept`).
- The non-default action is always available as a secondary text link under the banner. Choosing "accept anyway" when comments imply edits triggers a `confirm()` warning.

The agent provider ([src/agentProvider.ts](src/agentProvider.ts), called by [src/agent.ts](src/agent.ts)) gets the verdict by asking the selected local agent to reply in a delimiter envelope rather than JSON:

```
REQUIRES_REVISION: <true|false>
ESCALATE: <true|false>
REASON: <one short sentence>
---MESSAGE---
<free-form reply prose>
---END---
```

JSON was tried first and abandoned: agent replies frequently contain quotes, code fences, and Markdown that the model fails to escape inside a JSON string, which then makes `JSON.parse` blow up on the whole envelope. The delimiter form sidesteps escaping entirely. [src/parseReply.ts](src/parseReply.ts) prefers the delimiter form, accepts the legacy JSON shape as a fallback, and on any parse failure defaults to `{ requires_revision: true }` (safer to run an unnecessary revision than silently skip an implied edit).

The verdict is **agent-owned**. The human cannot flip it directly. Disagreement flows through a follow-up reply, which gives the agent a chance to re-classify rather than be silently overridden.

## Author handoff

The inline review agent and the agent that *authored/launched* `redline` are separate processes. The sidecar is the persisted artifact, and `.startup.json` gives the authoring agent a local API bridge while the session is live. Two mechanisms carry feedback back to it:

- **`ESCALATE` verdict.** The storage/envelope name is still `ESCALATE` for compatibility, but product language is **author reply needed**. The inline agent sets `ESCALATE: true` when a comment needs author-level input: information, tools, authority, or project context it cannot access from the document and comment thread (an external style guide, a spec to check against, a wider-project decision). It does **not** set it for ordinary requested edits, reframes, emphasis changes, rewrites, or approvals; those are handled by `requires_revision`. It's stored as `escalate?: boolean` on the agent's `ThreadEntry` and rendered as an "↑ Author reply needed" badge on the comment. The author handoff signal is independent of `requires_revision` — the agent judges each on its own.
- **Live author replies.** The authoring agent can run `redline author-wait <file>` while a session is open; it returns JSON when either a pending author-needed comment appears or the final `.result` is written. For pending comments, it can run `redline author-reply <file> <comment-id> --message "..."` to post back into the same thread, then wait again. When the server is live, the reply command uses `.review/<file>.startup.json` and the local API so the browser soft-refreshes; if the server is gone, it falls back to a locked sidecar write.
- **Closeout transcript.** On `finished`, the CLI loads the sidecar and prints every comment thread verbatim via [src/reviewSummary.ts](src/reviewSummary.ts) (`formatReviewSummary`), with a dedicated callout listing comments that need author input (`collectEscalations`). The count is also written to `.review/<file>.result` and appended to the `REDLINE_RESULT:` line. This remains the fallback read point for abandoned or unfinished sessions.

## Security & resilience as built

These are post-publish hardenings (M5/M8). They're load-bearing — don't regress them when refactoring:

- **Loopback bind.** Server is `Bun.serve({ port: 0, hostname: "127.0.0.1" })` in [src/cli.ts](src/cli.ts). No external interface.
- **Markdown sanitization.** `marked` v9 stopped sanitizing in-band; we run [`sanitize-html`](src/render.ts) over its output. Tests in [src/render.test.ts](src/render.test.ts) cover the dangerous-payload cases — keep them passing.
- **CSRF token.** The CLI mints `REDLINE_TOKEN` (a UUID) and threads it to the server (mints from), the agent subprocess (env), and the bundled client (via `window.__REDLINE__`). Mutating endpoints require `X-Redline-Token`. Don't add a mutating endpoint without checking the token.
- **Realpath on static asset reads.** [src/server.ts](src/server.ts) calls `realpath` before serving anything off disk so a symlink in `.review/history/` can't traverse out.
- **Cross-process sidecar lock.** [src/sidecar.ts](src/sidecar.ts) layers an in-memory mutex over `proper-lockfile` on `<sidecar>.lock`. Both layers are needed: in-process is the fast path, lockfile catches concurrent processes (e.g. `redline resolve` running while the server is up).
- **Prompt-input envelopes.** Both `agent.ts` and `resolve.ts` wrap user-controlled text (doc body, comment text) in `---DOCUMENT---` / `---COMMENTS---` style markers before sending to the selected agent provider, so a comment that contains "Ignore previous instructions" is recognizable as data, not prompt.
- **Revision watchdog.** [src/server.ts](src/server.ts) starts a 3-min timer on `/api/accept`. If `/api/reload` doesn't land in time, the round un-resolves and the server broadcasts `revision-stalled`. The revision token in `currentRevision` makes this race-safe — see the comment block at line ~129.
- **Revision integrity check + retry.** `validateRevision` in [src/resolve.ts](src/resolve.ts) is a pure check on the model's output: it strips fences/wrapper-tags/meta-sections, then rejects output that has no headings (when the input had them) or that drops a heading whose section no settled comment touched — the signal that the model mangled the doc instead of editing it. A failed validation retries the revision once with the same model before surfacing `revision-error`; a non-zero CLI exit is not retried (environment failure, not a model stumble).
- **Zombie SSE recovery.** [src/client/sse.ts](src/client/sse.ts) listens for `visibilitychange`/`focus` and runs a 30s heartbeat watchdog while the `.revising` banner is up, so a tab backgrounded across the whole revision recovers when refocused.
- **Capped agent restart.** [src/cli.ts](src/cli.ts) auto-restarts the agent on unexpected exit but caps at 5 in 60s. If you see "gave up" in the log, something structural is wrong — fix root cause, don't raise the cap.

## Tests

`bun test` runs the suite. Server, sidecar, parsing, model-picking, rendering, diff, SSE, integration, and happy-dom client tests all live in `tests/` and `src/`.

## Closeout

When the user asks to "close out" a fix/patch/feature after its PR is open, additional dev-process steps may apply. They're not documented in this public file — check local/private project notes if present, or fall back to project memory.
