# Redline retro log

Running log per `canon/docs/13-retro-process.md`. Entries land here as work happens; canon proposals are reviewed at milestone close.

---

## 2026-04-30 — Canon proposal: Per-milestone retro summary alongside the running log

**Observation.** At M2 close, we wrote a per-milestone retro summary at `docs/retros/m2-multi-round-revision.md` (a focused, narrative read of just M2's lessons) without first logging entries into a running `docs/retro.md`. We then noticed the gap: the per-milestone file is great for reading-the-milestone-back, but it doesn't replace the running log — cross-milestone patterns (e.g. "we keep hitting the same async UI race") only surface when entries are co-located, and the `Status` lifecycle on canon proposals (Proposed → Accepted/Rejected) needs a stable place across milestones. M1's retro went straight to canon commits without either artifact, so this is the second time the project has improvised on retro shape.

**Proposed canon change.** In `canon/docs/13-retro-process.md`, add a subsection under "At milestone close: running the retro" titled "Producing a per-milestone summary file" describing the additional artifact: a narrative file at `docs/retros/m<N>-<milestone-slug>.md`, written at close, that reads the milestone's lessons in a focused way for someone (or a future agent) trying to understand what M<N> taught the project. Keep it short and tight by default but allow it to grow if the milestone surfaced a lot of insights — length should match what the milestone actually taught, not a template. The running `docs/retro.md` remains the source of truth for entries and status; the summary file is a reading-friendly artifact derived from it. Update the "Steps" list to add a new step (between current step 3 and step 4): "Write a per-milestone summary at `docs/retros/m<N>-<slug>.md` covering shipped / harder than expected / learned / carrying forward. Link it from `docs/roadmap.md` on the milestone's `Retro:` line."

**Why universal.** Every Levi Studio project that uses functional milestones hits the same trade-off: a single running log is right for in-the-moment capture and cross-milestone pattern recognition, but reads poorly when you (or a fresh-session agent) want to understand "what did M2 teach us." The per-milestone file is the smallest fix — a derived artifact, not a replacement — so it doesn't trade off either property. It also gives the roadmap something concrete to link from (`Retro: docs/retros/m2-retro.md`), which makes the `Status: reached` line on a milestone genuinely useful as a navigation point rather than a flat assertion.

**Status.** Accepted — merged in [levi-studio#2](https://github.com/alevi/levi-studio/pull/2) (2026-04-30).
