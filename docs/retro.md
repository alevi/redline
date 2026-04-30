# Redline retro log

Running log per `canon/docs/13-retro-process.md`. Entries land here as work happens; canon proposals are reviewed at milestone close.

---

## 2026-04-30 — Canon proposal: Per-milestone retro summary alongside the running log

**Observation.** At M2 close, we wrote a per-milestone retro summary at `docs/retros/m2-multi-round-revision.md` (a focused, narrative read of just M2's lessons) without first logging entries into a running `docs/retro.md`. We then noticed the gap: the per-milestone file is great for reading-the-milestone-back, but it doesn't replace the running log — cross-milestone patterns (e.g. "we keep hitting the same async UI race") only surface when entries are co-located, and the `Status` lifecycle on canon proposals (Proposed → Accepted/Rejected) needs a stable place across milestones. M1's retro went straight to canon commits without either artifact, so this is the second time the project has improvised on retro shape.

**Proposed canon change.** In `canon/docs/13-retro-process.md`, add a subsection under "At milestone close: running the retro" titled "Producing a per-milestone summary file" describing the additional artifact: a narrative file at `docs/retros/m<N>-<milestone-slug>.md`, written at close, that reads the milestone's lessons in a focused way for someone (or a future agent) trying to understand what M<N> taught the project. Keep it short and tight by default but allow it to grow if the milestone surfaced a lot of insights — length should match what the milestone actually taught, not a template. The running `docs/retro.md` remains the source of truth for entries and status; the summary file is a reading-friendly artifact derived from it. Update the "Steps" list to add a new step (between current step 3 and step 4): "Write a per-milestone summary at `docs/retros/m<N>-<slug>.md` covering shipped / harder than expected / learned / carrying forward. Link it from `docs/roadmap.md` on the milestone's `Retro:` line."

**Why universal.** Every Levi Studio project that uses functional milestones hits the same trade-off: a single running log is right for in-the-moment capture and cross-milestone pattern recognition, but reads poorly when you (or a fresh-session agent) want to understand "what did M2 teach us." The per-milestone file is the smallest fix — a derived artifact, not a replacement — so it doesn't trade off either property. It also gives the roadmap something concrete to link from (`Retro: docs/retros/m2-retro.md`), which makes the `Status: reached` line on a milestone genuinely useful as a navigation point rather than a flat assertion.

**Status.** Accepted — merged in [levi-studio#2](https://github.com/alevi/levi-studio/pull/2) (2026-04-30).

---

## 2026-04-30 — Bun subprocess signal handlers do not run when killed via proc.kill()

When a parent Bun process calls `subprocess.kill("SIGINT")` or `subprocess.kill("SIGTERM")`, the OS terminates the child before the Bun event loop can dispatch the signal to a registered `process.on("SIGINT", ...)` handler. Exit code is 130 or 143 (killed by signal) rather than the code passed to `process.exit()` inside the handler. This does not affect real-world Ctrl+C usage — terminal SIGINT to a foreground process group works correctly — but it makes signal-path integration tests unreliable when using `proc.kill()` in Bun's subprocess API.

Fix: signal handlers that must write files before exiting should use synchronous I/O (`writeFileSync`, `mkdirSync`) rather than async promises. The sync call completes before the OS terminates the process, so the artifact lands even if the async event loop is preempted.

---

## 2026-04-30 — Canon proposal: Result-file pattern for long-running human-in-the-loop steps

**Observation.** Redline's outer-agent handoff initially used a blocking subprocess call: `redline <file>` ran as a Bash command and the calling agent waited on it. This capped reviews at the Bash tool's 10-minute timeout. The fix was to write a result file (`.review/<file>.result`) at every exit path, so the outer agent can either block on the subprocess (for short reviews) or background the process and poll the result file (for long reviews). The result file is a structured JSON with `status`, `file`, `rounds`, `comments`.

**Proposed canon change.** In `canon/docs/12-ai-workflow-patterns.md`, add a section (or subsection under a relevant existing section) titled "Long-running human-in-the-loop steps: result-file pattern." Content: when a studio AI workflow includes a human-in-the-loop step with unbounded duration — review, approval, form-filling — do not rely solely on blocking the calling agent's subprocess call. Instead: (1) write a result file at every exit path (success, abandon, error) before the process exits; (2) document the file path in the process's startup output; (3) let the calling agent choose whether to block on the subprocess or background it and poll the file. The result file shape should be stable across exits so the caller parses one format regardless of path taken.

**Why universal.** Any studio project that has a human-in-the-loop step exposed as a CLI subprocess will hit this pattern — the Bash tool timeout is a real ceiling. The blocking-or-polling choice gives callers flexibility without requiring the subprocess to know in advance how long the human will take.

**Status.** Proposed

---

## 2026-04-30 — Integration tests for CLI tools unlock fast feedback that manual testing can't provide

For a dogfooded CLI tool, the manual testing loop is interactive and expensive: start the server, open the browser, click through a flow, observe the result. It doesn't accumulate — each change requires the full sequence again. Writing integration tests (that spawn the actual subprocess and assert on exit codes, result files, and HTTP responses) seemed like overhead during M3, but once written they ran in under 2 seconds and immediately caught a real bug (the result-file write didn't land on the first attempt). The ROI was apparent on the first run.

The key enabler was keeping the test harness thin: no mocks, no test doubles, just real subprocess spawns with env var overrides to suppress side effects. The tests exercise the same code path production does.

---

## 2026-04-30 — Testability env vars for side-effect-heavy CLI tools

When writing integration tests for a CLI that has observable side effects (opening a browser, starting timers, writing files), test runs become noisy or slow if the production behavior runs unconditionally. The fix used in M3: env var overrides that suppress or shorten side effects during tests — `REDLINE_NO_OPEN=1` to skip the browser open, `REDLINE_ABANDON_MS=N` to shorten the abandonment grace period. Both are checked in the CLI with a single conditional and default to the production value when absent. The test suite sets them; production callers never need to know they exist.

This is worth noting because the first instinct is often to add a `--test` flag or a mock layer. Env vars are less invasive: no CLI surface changes, no test-mode branching in application logic, and they compose naturally with child processes (child inherits the env).

---
