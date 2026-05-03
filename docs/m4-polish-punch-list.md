# M4 polish punch list

Findings from a full-flow review of the chrome and transitions on `sample.md`. Driven via Claude in Chrome with `--context "Look for assumptions that won't hold under load"`. Reviewed: cold open, all markdown elements, selection edge cases, card stacking, reply flow, resolve flow, multi-round revision, diff overlay.

Severity:
- **P0** — broken behavior, blocks the flow, surfaces bad data
- **P1** — jarring or noticeably wrong, hurts the feel
- **P2** — cosmetic, would polish to a higher bar

Status:
- 🔍 logged, needs decision/work
- 🛠 fixed inline (this PR)
- ❓ needs design call (left for the human)

---

## What works well

The agent loop is solid: parallel replies, thinking dots per card, one-shot agent-replied event. Multi-round revision pipeline works end-to-end (R1 → R2 → R3). Highlights anchor correctly across paragraphs, code blocks, blockquotes, and headings. Cross-paragraph selection produces multi-fragment highlights that look natural. Cascade positions cards near their highlights. Diff overlay renders pretty side-by-side blocks with formatting preserved. Post-revision banner replaces the old auto-modal cleanly. Context banner shows + dismiss persists. Resolved cards collapse to a tidy summary. Round picker exposes prior rounds as read-only history. Tables, hard line breaks, multi-paragraph blockquotes, nested lists all render.

---

## Punch list

### 1. Selection / new-comment form

**P2 🔍 Single-character selections create a comment.** Selecting just one letter triggers the form. Defensible, but easy to do accidentally with a stray click-drag. Suggest: require ≥2 chars before opening the form, or trim the selection if it's pure punctuation/whitespace.

**P1 🔍 Form has no top-of-doc / bottom-of-doc collision handling.** When selection is at the very top, the form's `top: Math.max(0, formTop)` keeps it in bounds. But near the bottom of a short doc, the form can extend below the sidebar's content height (sidebar follows doc height). Untested at the truly minimal-doc case but worth a smoke test — risk is the Save button getting clipped.

### 2. Card rail / stacking

**P0 🛠 Reply form open → next card appears to bleed into the active card.** The z-index fix elevates the active card paint order, but `positionCards()` is **not** called after `toggleReplyForm`. Card heights change when the form opens; the cascade doesn't re-flow; the next card's content peeks out below the reply form, looking like part of the active card's thread. Fix: call `positionCards()` inside `toggleReplyForm` after the toggle. (Fixed inline.)

**P1 🔍 Cards don't visually compress when crowded.** Three comments anchored to consecutive list items result in cards stacked tightly with only an 8px gap. The cascade math is correct but the gap is tight enough that scanning the rail feels cluttered. Consider increasing the inter-card gap to 12–16px, or adding a subtle separator.

**P1 🔍 Resolved cards show the full agent reply as a "commitment" preview.** The `.card-commitment` block renders the full agent message (often 4–6 lines) under the collapsed card. That defeats the purpose of collapsing. Fix: truncate the commitment to ~80 chars with a trailing `…`, or show only the first sentence. The full reply remains accessible on expand.

**P1 🔍 First card stays "active" indefinitely after creation.** When you create the first comment, its card gets the active red border. The border doesn't clear until you click somewhere else. Borderline confusing because nothing visible says the card is in a special state. Suggest: clear active state on a timer after creation, or only set active on user click.

### 3. Resolve flow

**P0 🛠 Scroll-to-top on all-resolved doesn't fire.** The smooth scroll-to-top is overridden by the SSE-triggered `softRefresh → preserveScroll` race. `resolveComment` calls `window.scrollTo({top: 0, behavior: 'smooth'})`, but ~milliseconds later the `comment-resolved` SSE arrives, fires `softRefresh`, which captures the in-flight intermediate scroll position and restores it. Result: scroll never reaches top. Fix: defer the scroll until after the next animation frame, OR mark the page with a flag that suppresses preserveScroll while a deliberate scroll is in flight, OR use `behavior: 'instant'`. (Fixed inline with rAF deferral + a brief preserveScroll suppression flag.)

**P0 🛠 `/api/comment/:id/reopen` doesn't broadcast an SSE event.** Other tabs and the agent never learn about the reopen. UI gets stale. The agent thinks the comment is still resolved. Fix: add `broadcast("comment-reply", { round: round.round, commentId: id })` (or a new `comment-reopened` event) after saving the sidecar in the reopen handler. (Fixed inline by emitting `comment-resolved` with `allResolved` recomputed — same SSE path the client already handles for state changes.)

### 4. Revision flow

**P0 🔍 No-changes revision leaves UI in a partial-update state.** When the agent's revision produces no changes: `revision-no-changes` SSE fires, banner shows for 5s, softRefresh updates `comments` to the new round's empty list — but the round badge stays at "Round 1" because the page never reloads. The user sees a "Done" button, no comments, but the badge is wrong. The next reload would show "Round 2 of 2". Fix: on `revision-no-changes`, either trigger a `window.location.reload()` (treat the same as a reload event) or update the round badge directly via softRefresh.

**P1 🔍 During revision, all resolved cards expand to show full HUMAN+CLAUDE threads.** The `roundResolved=true` path in `applyRoundState` triggers `renderComments()`, which apparently renders resolved cards differently (no collapse). Result: while the user watches the revision streaming banner, the rail below it expands into a wall of text recapping every comment thread. Suggest: keep cards collapsed during revision; the stream is the focus.

**P1 🔍 Streaming banner overlaps the rail visually.** The amber "Revising the document" banner sits at the top of the sidebar column. The first comment card immediately below it has only a small gap. The streaming agent text inside the banner can be long enough to push down into card territory. Should have explicit margin-bottom and ideally clear visual separation.

**P0 🔍 Agent appends "Settled comments" / "Previously agreed changes" sections to the revised doc.** Looking at sample.md after revision, the agent appended ~30 lines of meta-discussion to the bottom of the document — every comment thread dumped as a list. This pollutes the doc and is the opposite of what revisions should do. Not strictly a chrome bug — the resolve.ts prompt is telling the agent to do this — but it's a P0 because it wrecks the artifact. *Action: review and tighten the resolve prompt.*

### 5. Diff overlay

**P1 🔍 No close × on the diff overlay.** Two buttons: "Give more feedback" (closes overlay, returns to session) and "Looks good — close session" (calls /api/finish, ends session). To dismiss without committing, you must click "Give more feedback" — a misleading label for "I just want to close this." Add an explicit × in the header that's equivalent to "Give more feedback" but reads honestly.

**P1 🔍 Diff body uses different link styling than the prose.** Prose links are accent-red underline; diff body links are blue underline. Inconsistent — pick one. Probably the diff variant (blue) is better; consider matching the prose to it.

### 6. Header / round picker

**P1 🔍 Round badge reads "Round 1" with no "of N" suffix on Round 1.** Once you reach Round 2+ the badge becomes "Round 2 of 2" and gets a clickable round picker with the orange "repeat" styling. On Round 1 it's just "Round 1" — fine but inconsistent. Either always show "of N", or never. *Needs design call.*

**P1 🔍 Header height shifts when btn-accept text changes.** `Revise document` → `Revise document ✓` → `✓ Accepted` → `Done` → `✓ Done` — different widths, different vertical heights when long labels wrap. The doc title and round badge shift slightly each time. Fix: give btn-accept a `min-width` so all label states fit without resize.

**P2 🔍 Sticky comment-nav is replaced by sidebar status banner when all-resolved.** The "1/N open ↑Prev Next↓" nav disappears when all comments are resolved. That's correct (nothing to navigate to), but the transition is abrupt. Suggest: fade between them, OR keep the nav showing a count and disabled buttons.

### 7. Empty / cold-open states

**P2 🔍 Empty rail in cold-open feels barren.** Big blank column on the right, no signal that you can do anything with it. Suggest a subtle hint ("Select text to leave a comment") that disappears after the first selection. *Needs design call — risks feeling tutorial-y.*

**P2 🔍 "Done" button enabled immediately when there are no comments.** Reads like "I'm done reading the doc" rather than "skip review and exit." Reasonable behavior, but the affordance is louder than the action's stakes — it ends the session. Consider muting the button or giving it slightly different copy ("Skip review" / "Close without revising") when there are no comments at all.

### 8. Markdown rendering

**P0 🔍 Local image paths 404 silently.** `![arch](./diagram.png)` is broken because the server has no static asset route. Real specs constantly reference local diagrams; this will surface immediately on real use. Fix: add `app.get("/_asset/*")` that serves files from the markdown's directory (with path-traversal protection), and rewrite `<img src>` to point through it during render. *Needs design call: same-dir only, recursive subdirs, or sibling `assets/` only?*

**P0 🔍 Broken images render as ugly browser-default broken icons.** Both 404s and unreachable hosts show the small icon + alt text. Looks like Redline is broken. Fix: `img { max-width: 100% }` and an `onerror` handler that swaps for a styled "image failed to load: <alt>" placeholder.

**P0 🔍 Task list items have both bullet AND checkbox.** `• ☐ Foo` instead of `☐ Foo`. Marked emits `<li class="task-list-item">` with an inline `<input type="checkbox">` — needs CSS to suppress the `<ul>` bullet for these items. Also style the checkbox itself; the native gray default looks accidental. (Fixed inline.)

**P0 🔍 Code block visual mass dominates the prose.** Dark `#1e1e1e` block reads as a billboard inside body copy. Two paths: (a) lighter `#f6f8fa` GitHub-style background, or (b) keep dark but reduce vertical padding. *Needs design call.*

**P1 🔍 H3 and H4 are nearly indistinguishable from each other and from bold paragraphs.** H3=1.15em, H4=1em, both weight 600. In context, they read as "two short bold paragraphs," not as a hierarchy. Specs use H3/H4 heavily. Fix: bump H3 size + top margin, give H4 muted color or tracking change. (Fixed inline.)

**P1 🔍 Image rendering has no max-width / alignment styling.** A real 1200px PNG would blow the prose layout. Fix: `.prose img { max-width: 100%; height: auto; display: block; margin: 1em auto; border-radius: 4px; }`. (Fixed inline.)

**P1 🔍 Tables have no row separators or alternating backgrounds.** Render works (browser defaults) but accidental polish — no `.prose table` rule. Add explicit table styles so the look is intentional and won't drift.

**P1 🔍 Strikethrough and `del` have no explicit styles.** Browser default. Works but worth muting the color so it reads as "rejected" rather than "removed in error."

**P1 🔍 Link color (red accent) clashes with comment-active highlight (also red accent).** Hard to tell at a glance which is which when active card and link coexist. Pick a different link color (blue, or a different red shade).

**P2 🔍 Code block right-edge padding feels tighter than left.** Verify by inspect.

### 9. Agent reply behavior (chrome-adjacent)

**P1 🔍 Agent replies are too long and conversational for trivial test comments.** "Got it — you've flagged the `greet` function. Would you like me to adjust this code (e.g., add error handling, change the syntax, or expand the example), or is this just testing that comments work on code blocks?" — for a one-line user comment, this is a paragraph. Not a chrome bug, but it makes the cards bloat. *Action: review and tighten the agent prompt to default to terse acknowledgements unless the human's comment requires more.*

### 10. Workflow / round picker

**(out of scope notes)** Tested round picker briefly — it works. Click prior round → read-only view with "Read-only — back to current" link. Highlights and cards rendered for that historical state. Solid.

---

## What I did NOT test (deferred)

- ~~SSE reconnect mid-revision~~ — done in PR #5; client reconciles totalRounds on reconnect and reloads if a new round appeared while disconnected.
- ~~Selection that overlaps an existing highlight~~ — done in PR #5; nested marks render, innermost wins on click, active outline traces the exact span.
- Tab close + reopen within abandon grace
- Triple-click for paragraph selection (works in theory; the 250ms debounce is in place)
- Cmd+A select-all behavior
- Microinteraction polish (hover states, transition speeds) — partial
- Window resize / responsive behavior
- Selecting identical text appearing in multiple places (anchor disambiguation)

---

## Followups surfaced during PR #5 dogfood (not P0/P1 polish, but worth tracking)

1. **Abandonment timer fires during temporary disconnects.** A short DevTools-offline test was enough to trip the 120s grace and kill the server. Fix candidates: extend the grace when the browser was recently connected, or distinguish "never-here" from "was-here-now-gone" with a longer second-chance window.
2. **Agent subprocess is fragile to harness-level reaping.** `cli.ts` spawns `agent.ts` as an attached child; the agent in turn spawns `claude -p` subprocesses. When the outer harness reaps the parent's process group, everything dies. Fix candidates: `detached: true` on the agent spawn, agent self-restart on subprocess crash, or move off the `claude -p` subprocess to the SDK directly.
3. **Revision crash is reported as `abandoned` instead of `error`.** When the resolve subprocess crashed, the snapshot was saved correctly and the visible file was unchanged — but the result file used the wrong terminal signal. Tighten the failure path so the outer caller sees `error` (or `revision-failed`) when something actually broke.
4. **Multi-fragment selection anchors.** Selections that cross images or section boundaries currently bail (`Highlight a single passage…`). Fix would change the sidecar shape: a comment's anchor becomes a *list* of fragments, each with its own quote+context. captureSelection and highlightText both need to handle the list case. Probably an M5+ candidate.
5. **Two concurrent Redline instances under one harness — investigate whether that triggers (2).** Both this session and a sister session crashed at roughly the same time during testing. The most plausible link is harness-level process-group reaping, but it's unconfirmed. Worth reproducing deliberately and capturing exit signals + parent PIDs at time of death.
6. **Sidecar read-modify-write is racy under concurrent POSTs.** Each comment-creating endpoint does `loadSidecar` → mutate → `saveSidecar` with no locking. Two POSTs that interleave can lose one of the writes; >5 concurrent POSTs reliably 500. Discovered via a 20× parallel-POST test in the API coverage suite. Plausible fixes: serialize sidecar writes through a per-file mutex, or move to an append-only event log under the hood.
7. **Comment IDs were `c${Date.now()}` and collided when two POSTs landed in the same ms.** Fixed in the API-test PR (added a 4-digit random suffix), but worth noting as the kind of "obvious in hindsight" bug that test coverage surfaced immediately.

---

## Summary

**Strong**: parallel agent replies, multi-round flow, post-revision banner, diff overlay, highlight robustness, code block fence handling.

**Needs work most urgently** (the things I'd fix first):
1. Z-index fix incomplete — call `positionCards()` after toggle (P0, fixed)
2. Scroll-to-top suppressed by SSE softRefresh race (P0, fixed)
3. Reopen doesn't broadcast SSE (P0, fixed)
4. No-change revision leaves stale round badge (P0)
5. Local image paths 404 silently (P0)
6. Task list items show bullet + checkbox (P0, fixed)
7. Resolved card commitment shows full agent reply (P1)
8. Agent reply length / appended "Settled comments" sections in revised docs (P0/P1, prompt-side)

The chrome is more correct than I expected; the surprises are mostly in the second-order interactions (scroll vs SSE, reopen silence, no-change reload gap).
