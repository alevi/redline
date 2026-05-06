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
- **Status:** reached
- **Retro:** [docs/retros/m3-retro.md](retros/m3-retro.md)

### M4: UX polish

- **Done when:** The review experience feels fluid and intentional end-to-end. No jarring transitions, no scroll jumps, micro-interactions feel considered.
- **Status:** reached
- **Retro:** [docs/retros/m4-ux-polish.md](retros/m4-ux-polish.md)

### M5: Resilience pass v2

- **Done when:** The 7 followups surfaced during M4 dogfood + test buildout (see `docs/m4-polish-punch-list.md`) are addressed or explicitly deferred. The system tolerates concurrent writers, brief network blips, harness-level subprocess reaping, and surfaces failure modes honestly. No silent state-divergence between sidecar, server, and agent.
- **Status:** reached
- **Work items (in suggested order):**
  - **#3 Revision-crash signal mismatch** (small): when the resolve subprocess crashes, the result file should report `error` (or a more specific failure status), not `abandoned`. Tighten the failure path so the outer caller can distinguish "user walked away" from "revision actually broke."
  - **#1 Abandonment timer fires during temporary disconnects** (small): a brief offline window (e.g. DevTools offline test) is enough to trip the 120s grace and kill the server. Distinguish "never connected" from "was here, briefly gone" with a longer second-chance window.
  - **#6 Sidecar read-modify-write race** (medium, high impact): every comment-creating endpoint does `loadSidecar` → mutate → `saveSidecar` with no locking. Two POSTs that interleave can lose a write; >5 concurrent POSTs reliably 500. Per-file mutex or append-only event log.
  - **#2 Agent subprocess fragile to harness-level reaping** (medium, architectural): `cli.ts` spawns `agent.ts` as an attached child; the agent in turn spawns `claude -p` subprocesses. When the outer harness reaps the parent's process group, everything dies. Plausible fixes: `detached: true` on the agent spawn, agent self-restart on subprocess crash, or move off the `claude -p` subprocess to the SDK directly.
  - **#5 Two-concurrent-Redlines crash pattern** (investigation): both this session and a sister session crashed at roughly the same time during M4 testing. Most plausible link is the same harness reaping that #2 addresses. Reproduce deliberately and capture exit signals + parent PIDs.
- **Out of scope (deferred to their own efforts):**
  - **#4 Multi-fragment selection anchors** (cross-image, cross-section): adds new capability rather than fixing existing behavior; sidecar schema change. Earns its own scope when a real doc needs it.
  - **Phase 4 of test milestone** (client JS extraction + browser-driven tests): testing infrastructure expansion, not resilience. Slot after M5 so the new resilience changes get coverage at the same time.
- **Post-M5 patch (small, shipped):** [docs/deferred-browser-open.md](deferred-browser-open.md) — stop auto-opening the browser; print a cmd-clickable URL instead. UX paper-cut surfaced during M4 dogfood. Shipped in [redline#23](https://github.com/alevi/redline/pull/23).
- **Retro:** [docs/retros/m5-resilience-v2.md](retros/m5-resilience-v2.md)

### M5_P1: Verdict-aware resolve

- **Done when:** Every agent reply carries a verdict on whether the resolved comment implies a doc edit. The round-level action defaults to "Revise document" or "Accept as-is" based on the verdicts; the alternate action is one click away. Per-reply footer + per-card badge make the verdict legible *before* the human clicks Resolve.
- **Status:** reached
- **Why a patch, not part of M5:** UX/workflow change, not resilience. Surfaced during dogfood: the only path forward after even one comment was a full revision pass, even when every thread was just Q&A the agent had already answered.
- **Out of scope:** classifying without agent JSON output (e.g. inferring from message text), per-comment human override of the verdict, scoping the revision pass to only revision-implying comments. The last is the most interesting follow-up — could make revision lighter/faster — flagged for a future patch.
- **Retro:** [docs/retro.md — 2026-05-03 entry](retro.md). Shipped in [redline#22](https://github.com/alevi/redline/pull/22).

### M6: Load-bearing integration

- **Done when:** Redline is wired into the normal course of work across active projects. Agents reach for it automatically when producing a Markdown proposal for human sign-off — without explicit instruction each time. The invocation path (skill, global guidance, `--context` handoff) is polished and trusted. Used on at least two or three real proposals outside the Redline project itself.
- **Status:** reached
- **Work items:**
  - ✅ Update the `redline-review` skill to document `--context` and the outer-agent handoff pattern. Shipped in [redline#26](https://github.com/alevi/redline/pull/26).
  - ✅ Install the skill globally (`~/.claude/skills/`) so it's available in all projects, not just this repo. Install script shipped in [redline#27](https://github.com/alevi/redline/pull/27); copied to `~/.claude/skills/redline-review/` and confirmed visible in Claude Code's available-skills list. Patched in [redline#29](https://github.com/alevi/redline/pull/29) and [redline#31](https://github.com/alevi/redline/pull/31) once outside-redline sessions surfaced PATH and URL-surfacing gaps.
  - ✅ Add a short global `~/.claude/CLAUDE.md` rule: when producing a Markdown doc for human sign-off, reach for `redline-review` instead of pasting inline or just linking the file.
  - ✅ Validate on real proposals — at least two outside this project. **Validation 1** (drift-report M1 prep doc, recurring-merchant): full review with comments and replies; surfaced 5 product bugs that all shipped in [#32–#36](https://github.com/alevi/redline/pulls?q=is%3Apr+is%3Aclosed+%23). **Validation 2** (a doc-accept session with no comments): the agent reached for `redline-review` automatically and the human took the "Accept doc" path with no friction.
- **Retro:** [docs/retro.md — 2026-05-04 M6 close entry](retro.md).

### M7: Client-side test coverage

- **Done when:** The browser-side JavaScript currently embedded in `src/server.ts` as a Hono template literal (~half of the file's 2600 lines) is extracted into a real source file with a build/serve path, and is covered by automated tests. The interactions identified in M4 retro as test-blocking — `applyHighlights`, `focusComment`, `updateNav`, selection capture, scroll preservation across rebuilds — have direct test coverage. Any client-side bugs that surface during M6's real-usage validation get tests added at the same time.
- **Status:** planned (after M6; deferred from M4 phase 4 + M5 explicitly)
- **Work items:**
  - Extract embedded client JS from `src/server.ts` into a separate file; preserve server-side interpolation where required
  - Pick a browser test runner (Playwright, happy-dom, or Bun's WebKit equivalent) consistent with the existing Bun test harness
  - Cover the M4-flagged interactions (highlights, focus, nav, selection, scroll preservation)
  - Fold in any client-side bugs surfaced by M6 real-usage validation
- **Retro:**

### M8: Multi-file review sessions

- **Done when:** A single Redline session can span multiple Markdown files — e.g. a work stream that produces several proposals, a feature spec split across docs, a directory of related notes. The reviewer navigates between files in one browser session; each file has its own sidecar (no schema change — the per-file mutex from M5 #6 already supports independent queues); the agent and resolve flows operate per-file with optional cross-file context. The result file communicates session-level outcome back to the calling agent.
- **Status:** planned (after M7; surfaced during M5 retro review when the user asked whether the per-file mutex would block multi-file work)
- **Open design questions** (resolve when scoping):
  - CLI shape: positional list (`redline a.md b.md`), glob (`redline 'specs/*.md'`), or directory (`redline --dir specs/`)
  - Navigation: file picker, sidebar tree, tabs, or keyboard shortcut
  - Cross-file agent context: does the agent see the full set when replying, or just the active file?
  - Result file: single session-level result or per-file results
- **Retro:**

### M9: Typed comment actions

- **Done when:** The comment grammar supports typed actions (`[expand]`, `[challenge]`, `[cut]`, …) derived from the natural taxonomy that emerged from real usage in M1–M4 (and M6). Free text remains supported.
- **Status:** planned (waiting on real usage to inform the taxonomy)
- **Retro:**

## Now

What needs to happen immediately?

## Next

What follows after the first working slice?

## Later

What should wait until the product earns more scope?
