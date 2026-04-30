# Roadmap

## Milestones

Functional milestones for Redline. See `docs/studio-context.md` and `canon/docs/03-project-shape.md` for what a milestone is.

### M1: Single-pass review loop

- **Done when:** Agent writes a markdown file, a human comments inline in the browser, the agent reads and resolves the comments in one pass, and the document is regenerated. Round-trip works end-to-end.
- **Status:** reached
- **Retro:** retro entries already feeding canon (see commits `c2b408a`, `5499189`, `a5a1a2a` adding browser-UI patterns and async-indicator guidance to LeviStudio canon)

### M2: Multi-round revision cycles

- **Done when:** A review can span multiple rounds. Comments persist across rounds with status (open / resolved / superseded), the agent sees prior rounds when responding, the human can sign off explicitly, and an outer agent can launch a review and continue once the human is done.
- **Status:** reached
- **Retro:** [docs/retros/m2-multi-round-revision.md](retros/m2-multi-round-revision.md) — closed by dogfooding the redline-review skill on its own retro.

### M3: Resiliency pass

- **Done when:** A session can be started and completed without silent failures or stuck states. All error paths surface visibly in the UI. No session-ending bugs on the happy path. Long reviews and abandoned sessions both have a defined story.
- **Status:** planned
- **Carry-ins from M2:**
  - Tab-close abandonment isn't detected. SIGINT works, but a closed browser tab leaves the server running indefinitely — and blocks the outer agent until the 10-minute Bash timeout fires.
  - Review duration is capped at 10 minutes by the calling agent's Bash timeout. Likely needs a result-file handoff (`.review/<file>.result`) so the outer agent can `until [ -f result ]` instead of waiting on a subprocess.
  - Error logging exists on the resolve path. Comment-reply failures still die quietly.
- **Retro:**

### M4: Typed comment actions

- **Done when:** The comment grammar supports typed actions (`[expand]`, `[challenge]`, `[cut]`, …) derived from the natural taxonomy that emerged from real usage in M1/M2. Free text remains supported.
- **Status:** planned (waiting on real usage to inform the taxonomy)
- **Retro:**

### M5: UX polish

- **Done when:** The review experience feels fluid and intentional end-to-end. No jarring transitions, no scroll jumps, micro-interactions feel considered.
- **Status:** planned
- **Nits queued:**
  - Scroll to top of document after all comments in a round are resolved (signals "ready to revise").
  - Post-revision state: after a revision lands, the user should be reading the *new* version of the doc fresh (no inherited comments), with the prior round + its comments accessible as history, and a clear "new version ready — accept or comment" affordance. Current flow auto-opens a diff overlay that demands a verdict before reading; that's not the right shape. Consider inlining the diff highlights into the doc rather than a modal.
  - Handoff from outer agent into the browser is jarring. Context the outer agent provided in chat (why this doc needs review, what to look for) doesn't make it into the browser, so a user who isn't watching the prompt opens the tab cold. Surface a one-liner from the outer agent at the top of the reader.
  - Reply box renders behind the next comment card down. Z-index / stacking context bug in the right rail.
- **Retro:**

## Now

What needs to happen immediately?

## Next

What follows after the first working slice?

## Later

What should wait until the product earns more scope?
