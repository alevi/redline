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
- **Status:** planned (next)
- **Work items (in suggested order):**
  - **#3 Revision-crash signal mismatch** (small): when the resolve subprocess crashes, the result file should report `error` (or a more specific failure status), not `abandoned`. Tighten the failure path so the outer caller can distinguish "user walked away" from "revision actually broke."
  - **#1 Abandonment timer fires during temporary disconnects** (small): a brief offline window (e.g. DevTools offline test) is enough to trip the 120s grace and kill the server. Distinguish "never connected" from "was here, briefly gone" with a longer second-chance window.
  - **#6 Sidecar read-modify-write race** (medium, high impact): every comment-creating endpoint does `loadSidecar` → mutate → `saveSidecar` with no locking. Two POSTs that interleave can lose a write; >5 concurrent POSTs reliably 500. Per-file mutex or append-only event log.
  - **#2 Agent subprocess fragile to harness-level reaping** (medium, architectural): `cli.ts` spawns `agent.ts` as an attached child; the agent in turn spawns `claude -p` subprocesses. When the outer harness reaps the parent's process group, everything dies. Plausible fixes: `detached: true` on the agent spawn, agent self-restart on subprocess crash, or move off the `claude -p` subprocess to the SDK directly.
  - **#5 Two-concurrent-Redlines crash pattern** (investigation): both this session and a sister session crashed at roughly the same time during M4 testing. Most plausible link is the same harness reaping that #2 addresses. Reproduce deliberately and capture exit signals + parent PIDs.
- **Out of scope (deferred to their own efforts):**
  - **#4 Multi-fragment selection anchors** (cross-image, cross-section): adds new capability rather than fixing existing behavior; sidecar schema change. Earns its own scope when a real doc needs it.
  - **Phase 4 of test milestone** (client JS extraction + browser-driven tests): testing infrastructure expansion, not resilience. Slot after M5 so the new resilience changes get coverage at the same time.
- **Retro:**

### M6: Load-bearing integration

- **Done when:** Redline is wired into the normal course of work across active projects. Agents reach for it automatically when producing a Markdown proposal for human sign-off — without explicit instruction each time. The invocation path (skill, global guidance, `--context` handoff) is polished and trusted. Used on at least two or three real proposals outside the Redline project itself.
- **Status:** planned (after M5 Resilience pass v2)
- **Work items:**
  - Update the `redline-review` skill to document `--context` and the outer-agent handoff pattern (currently undocumented)
  - Install the skill globally (`~/.claude/skills/`) so it's available in all projects, not just this repo
  - Add a short global `~/.claude/CLAUDE.md` rule: when producing a Markdown doc for human sign-off, reach for `redline-review` instead of sharing inline
  - Validate on real proposals — at least two outside this project — and close any gaps that surface
- **Retro:**

### M7: Typed comment actions

- **Done when:** The comment grammar supports typed actions (`[expand]`, `[challenge]`, `[cut]`, …) derived from the natural taxonomy that emerged from real usage in M1–M4. Free text remains supported.
- **Status:** planned (waiting on real usage to inform the taxonomy)
- **Retro:**

## Now

What needs to happen immediately?

## Next

What follows after the first working slice?

## Later

What should wait until the product earns more scope?
