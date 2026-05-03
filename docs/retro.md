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

**Status.** Accepted — merged in [levi-studio#7](https://github.com/alevi/levi-studio/pull/7) (2026-04-30).

---

## 2026-04-30 — Integration tests for CLI tools unlock fast feedback that manual testing can't provide

For a dogfooded CLI tool, the manual testing loop is interactive and expensive: start the server, open the browser, click through a flow, observe the result. It doesn't accumulate — each change requires the full sequence again. Writing integration tests (that spawn the actual subprocess and assert on exit codes, result files, and HTTP responses) seemed like overhead during M3, but once written they ran in under 2 seconds and immediately caught a real bug (the result-file write didn't land on the first attempt). The ROI was apparent on the first run.

The key enabler was keeping the test harness thin: no mocks, no test doubles, just real subprocess spawns with env var overrides to suppress side effects. The tests exercise the same code path production does.

---

## 2026-04-30 — Testability env vars for side-effect-heavy CLI tools

When writing integration tests for a CLI that has observable side effects (opening a browser, starting timers, writing files), test runs become noisy or slow if the production behavior runs unconditionally. The fix used in M3: env var overrides that suppress or shorten side effects during tests — `REDLINE_NO_OPEN=1` to skip the browser open, `REDLINE_ABANDON_MS=N` to shorten the abandonment grace period. Both are checked in the CLI with a single conditional and default to the production value when absent. The test suite sets them; production callers never need to know they exist.

This is worth noting because the first instinct is often to add a `--test` flag or a mock layer. Env vars are less invasive: no CLI surface changes, no test-mode branching in application logic, and they compose naturally with child processes (child inherits the env).

---

## 2026-05-02 — Idempotent re-renders must preserve transient UI state explicitly

M4 surfaced several "the wrong card is highlighted" / "scroll jumped to top" / "first-created card stays active forever" bugs. Root cause was always the same shape: an SSE event fired softRefresh, which rebuilt the comment cards from scratch, which dropped the `.active` class on whatever card the user was looking at. The page state was driven entirely from server data, but transient UI state (active selection, scroll position, focus) lives only in the DOM. Rebuild, lose state.

The fix that worked: before rebuilding, capture the transient state (which card has `.active`, current `scrollY`, currently-focused element); after the rebuild, restore it. This is `preserveScroll(fn)` and the active-class preservation in `renderComments`. The pattern generalizes — any reactive UI driven by server pushes needs to be honest about what state lives where, or stuff the user cares about gets clobbered on every event.

---

## 2026-05-02 — Tight coupling between "what to render" and "where focus goes" hides bugs

`updateNav()` updated the comment-nav UI (`X / Y open` count, prev/next button states) AND called `navigateTo(open[navIdx].id)` on every invocation. Since `navIdx` defaulted to 0, every softRefresh secretly moved focus back to the first card — which masked an entirely separate fix to `saveComment` that was *trying* to set focus on the new card.

It took console-stack traces to find: the new card *did* get focus correctly, then a millisecond later `updateNav → navigateTo` snatched it back. The lesson is structural: a function whose name suggests "update labels" should not also be moving focus. Separating render from navigation made the actual bug obvious. Worth carrying as a code-smell heuristic — "this function does N things" hides at least N-1 bugs.

---

## 2026-05-02 — Promise.race(read, sleep) leaks the loser; the next read sees a poisoned reader

While building the SSE test helper (`waitForEvent`), I used `Promise.race([reader.read(), Bun.sleep(timeout).then(throw)])` to give each read a per-iteration timeout. The pattern looks clean. It is not.

When the read wins, the sleep keeps running in the background; harmless. But when the race timeout *almost* fires concurrent with a read resolving, the next iteration calls `reader.read()` again on the same reader — which now has a pending unresolved read from the previous iteration. ReadableStream readers don't allow concurrent reads. Symptoms: tests time out at 8s with no useful error, and the agent flow that obviously works in a standalone script fails inside the test harness.

Fix: a single `setTimeout` that aborts the underlying fetch on timeout, plus AbortError → "Timed out" translation in the read loop's catch. Lesson: `Promise.race` is fine for one-shot races; in a loop, the loser's cleanup matters as much as the winner's value.

---

## 2026-05-02 — Spawned subprocess deadlocks if the parent stops draining its piped stdout

Test harness was spawning the Redline CLI with `stdout: "pipe"`, reading the pipe until the URL line appeared, then dropping the reader. Worked fine for the existing integration tests because they exercised short-lived endpoints. Broke immediately when I added agent-driven tests: the agent inherits stdout from the CLI; once the pipe buffer filled (a few hundred lines of `[agent]` logs), the agent blocked on its next write, SSE handling stalled, tests timed out at 8s with no error.

Fix: spawn helpers must drain both stdout and stderr for the lifetime of the process, not just until the marker line they care about. Cheap to do (a fire-and-forget reader loop that ignores the bytes), expensive to debug from symptoms.

---

## 2026-05-02 — Async subprocess "ready" ≠ HTTP server "ready"

When the test harness spawned the CLI and waited for the URL line on stdout, then `waitForServer` confirmed the HTTP endpoint was responsive, the natural assumption was "everything is up — proceed." Wrong: the agent subprocess is started by the CLI in parallel and subscribes to `/api/events` *asynchronously*, typically a few hundred milliseconds after the URL is printed. Tests that posted a comment immediately after `waitForServer` resolved would silently time out because the agent missed the `comment-added` broadcast.

Fix: an explicit `agentReady` promise that resolves when "[agent] connected" appears in stdout. Cheap signal because the agent already prints it. Lesson: a multi-process system has multiple readiness states; one HTTP probe tests one of them.

---

## 2026-05-02 — Canon proposal: "Check PR state before pushing follow-up commits"

**Observation.** PR #5 was merged in the background while I kept working on the same branch. I pushed two more commits assuming the PR was still open; they sat orphaned on the merged-and-closed branch and never reached main. Recoverable via a fresh branch, but the trigger ("oh wait, my new commits aren't on main") only fired when the user asked. The harness gives no signal that an upstream PR has merged; the only way to know is `gh pr view`.

**Proposed canon change.** Add to `canon/docs/12-ai-workflow-patterns.md` (or wherever PR/git workflow guidance lives) a short rule under a "Continuing work on a branch" subsection:

> Before pushing follow-up commits to a branch that has an open PR, run `gh pr view` and check `state`. If the PR has merged or closed, push the new commits to a fresh branch off main instead — the dead branch is invisible to main, and your work won't ship from there.

**Why universal.** Any Levi Studio project that opens PRs and continues iterating on the branch hits this exact case the moment a PR is merged out-of-band (by the user, by another agent, by a merge queue). It's a narrow concrete rule, the cost is one shell command, and the recovery cost when missed is "create a new branch and re-PR" — annoying and easy to forget.

**Status.** Accepted — merged in [levi-studio#16](https://github.com/alevi/levi-studio/pull/16) (2026-05-03).

---

## 2026-05-02 — Canon proposal: "Polish + test surface area expose the same bugs from opposite directions"

**Observation.** The M4 milestone was scoped as "UX polish" — chrome and feel. Its sister effort was a test-coverage buildout (HTTP API, SSE, agent flow). Neither was scoped to find logic bugs. Both surfaced multiple real bugs that engineering completeness alone hadn't: scroll-vs-SSE race, reopen-doesn't-broadcast, focus-stays-on-first-card, ID collision, sidecar write race, agent-ready vs HTTP-ready race. The polish pass found bugs by *experiencing* the product carefully; the test pass found bugs by *enumerating* its surface area mechanically. Different mechanisms, comparable yields.

**Proposed canon change.** Add to `canon/docs/03-project-shape.md` under "What a milestone is" (or add a new sub-section):

> A milestone scoped as "UX polish" or "test coverage" will routinely surface logic bugs the previous engineering milestones missed. Treat this as expected, not as scope creep. Polish forces you to *experience* the product end-to-end at a different cadence than feature work; tests force you to *enumerate* its surface area mechanically. Both pressure-test assumptions made under the urgency of "make it work." Budget for in-flight bug fixes during these milestones, and let the followups bucket capture anything too big to fix inline.

**Why universal.** Every Levi Studio project that follows the M1–MN roadmap pattern eventually hits a polish or test milestone. The default mental model treats them as low-risk maintenance. They're not — they're a different lens on the same code, and the lens systematically catches things feature-shaped review missed. Naming the pattern in canon means the next project lead doesn't have to relearn it.

**Status.** Accepted — merged in [levi-studio#16](https://github.com/alevi/levi-studio/pull/16) (2026-05-03).

---

## 2026-05-03 — Date.now() alone is not enough for IDs, even in single-process code

Comment IDs were generated as `c${Date.now()}`. Two POSTs in the same millisecond — easy to do with two fast clicks on a local server, trivial to reproduce in tests — collided. Resolving by ID then resolved the wrong comment because `find` returned the first match. Surfaced by a parallel-POST test in the API coverage suite. Fix was a one-line change: append a 4-digit random suffix.

The lesson isn't really about IDs — it's about how easy it is to write code where the only "uniqueness" comes from "events don't usually happen this close together." The implicit assumption survives manual testing because manual testing is slow. Tests that fire actions in tight loops surface the assumption in seconds.

---

## 2026-05-03 — process.kill(pid, "SIGTERM") DOES fire JS signal handlers; subproc.kill() doesn't

M3 retro noted that Bun's `subprocess.kill("SIGINT")` doesn't deliver to a registered `process.on("SIGINT", ...)` handler — the OS terminates the child before Bun's event loop can dispatch. While reproducing the M5 #5 concurrent-crash hypothesis, I discovered the qualifier: this only applies to the Bun `subprocess.kill()` API. The standalone `process.kill(pid, "SIGTERM")` (a Node/Bun standard process API that sends the OS signal directly) does fire the JS handler in the target process, including under simultaneous delivery to two sibling processes.

This makes signal-path integration tests writable after all — they just need `process.kill(child.pid, ...)` instead of `child.kill(...)`. The new test in M5 #5 codifies this: two CLIs under simultaneous SIGTERM both reach their `process.on("SIGTERM", ...)` handler and land their result files via the M3 synchronous-write path.

The M3 retro entry isn't wrong, just narrower than the cleaner-than-expected story: `proc.kill()` is the unreliable one; OS signals via `process.kill(pid)` work.

---

## 2026-05-03 — Resolve flow hung silently; root cause never identified; symptom-level watchdog shipped

While dogfooding redline on its own M5 retro draft, the resolve flow stalled after the user clicked Revise. State at hang time: round 1 still `resolved_at` set, no round 2 in sidecar, file mtime unchanged, `errors.log` empty, `claude -p` no longer running, agent process alive and idle in the JS event loop. None of resolve.ts's exit paths (success branches reach `openNextRound`; error branches write `errors.log`) had fired.

First hypothesis was EPIPE: cli.ts had been launched with `bun run src/cli.ts <file> | head -30 &`, so the parent stdout pipe was broken. The theory was that `process.stdout.write` calls inside the streaming loop would throw EPIPE, derailing the resolve flow before its protocol fetches could fire. **This was wrong.** Direct probe confirmed Bun does not throw on broken-pipe stdout writes — it silently no-ops and returns false. Three reproductions of the user's exact conditions (small doc, full retro doc clean launch, full retro doc with `head -30` piping) all completed cleanly. The bug was real but not reliably reproducible.

The right defense without a known root cause is symptom-level. Shipped a server-side watchdog ([redline#18](https://github.com/alevi/redline/pull/18)): if no terminal event (`reload` / `revision-no-changes` / `revision-error`) arrives within `REDLINE_REVISION_TIMEOUT_MS` (default 3min) of `/api/accept`, the server un-resolves the round, broadcasts `revision-stalled`, and triggers the same recovery path as a known revision crash.

**What to capture next time a hang happens, before killing the session:** full agent process stack (`sample $PID 5`), `claude -p` stdout/stderr buffers if still running, `lsof -p $PID` for the agent (open pipes/fds tell you what it's actually awaiting), the SSE event log on the browser side (DevTools network panel → EventStream view), and the cli.ts output log if it was redirected to a file. The investigation that ran this time had only sidecar state, mtime, and the agent's idle-event-loop sample — enough to rule out theories but not enough to pin a cause.

**Lesson worth canon-ing.** When a system can hang in unidentifiable ways, ship a watchdog that catches the symptom class without requiring you to nail the cause. Pinning the cause is still the goal — but the watchdog buys you time and gives users a recovery path while you investigate. The cost is one timer and a clear-on-success contract.

---

## 2026-05-03 — Rebasing a stacked PR: both sides of the conflict often contain novel work

Stacked PR #14 (M5 #1) on origin/main while PR #13 (M5 #3) was waiting to merge. After #13 landed, rebasing #14 produced a conflict in `tests/integration.test.ts` — both branches had appended new tests in the same region. The default mental shortcut "take HEAD" or "take incoming" is wrong here: HEAD held the just-merged #13 tests, the incoming commit held the #1 test, and both were correct additions. I treated it as a single-side conflict on the first pass, dropping the #3 tests. Caught only because the test count came out one short.

The rule: when rebasing a stacked PR, conflict markers around appended-only regions almost always mean both sides contributed legitimate new work. The resolution is concatenation, not selection. Verify by counting: post-rebase test count = base (main) + new tests in this commit. Anything less means a side was dropped.

---

## 2026-05-03 — Embedded client JS in a server template literal is a testing wall

`server.ts` is ~2600 lines and a large fraction is browser JS embedded in a Hono template literal `<script>...</script>`. Convenient at the start — no build step, no asset pipeline, change anything by editing one file — but by M4 it had become structural debt. Phase 4 of the test-coverage milestone (browser-side coverage of `applyHighlights`, `focusComment`, `updateNav`, selection capture) cannot proceed without first extracting the script into a real file. Extraction is non-trivial because the script is interpolated with server-side state, so it's a real refactor, not a copy-paste.

Worth recording so a future project that's tempted to embed JS in a server template knows the cost: the convenience expires the moment client-side bugs become worth catching with tests, and at that point you pay for the refactor and the testing infrastructure together.

---
