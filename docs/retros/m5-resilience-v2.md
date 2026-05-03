# M5 Retro: Resilience pass v2

M5 closed the seven followups surfaced during M4 dogfooding and the test buildout. Five PRs landed in roughly the suggested order. Where M3 was the first resilience pass — silent failures, stuck states, abandon detection — M5 was the second pass, focused on the failure modes that only show up under load: concurrent writers, brief network blips, harness-level subprocess reaping, distinguishable failure signals.

## What we shipped

Five PRs, one per item:

- **#3 Revision-crash signal mismatch** ([redline#13](https://github.com/alevi/redline/pull/13)). Server gained `onRevisionError` / `onRevisionRecovered` callbacks; CLI tracks the last unrecovered revision failure. On abandon, the result file reports `status: "error"` with a `reason` field (exit code 3) instead of `abandoned` (exit 2) when a revision broke and never recovered. Recovery clears on `/api/accept`, `/api/reload`, and `/api/revision-no-changes`.

- **#1 Abandonment timer fires during temporary disconnects** ([redline#14](https://github.com/alevi/redline/pull/14)). Default abandon grace bumped from 2 minutes to 10 minutes. The reconnect-cancels-timer logic was already correct; the grace was just too tight for routine DevTools-offline debugging. The `REDLINE_ABANDON_MS` override is unchanged.

- **#6 Sidecar read-modify-write race** ([redline#15](https://github.com/alevi/redline/pull/15)). Added `withSidecar(filePath, fn)` — a per-file promise-chain mutex around the load → mutate → save cycle. Refactored every load+save pair in the server onto it. Mutators return a result (passed through) or `false` (skip save for validate-only paths). Regression test fires 20 simultaneous POSTs; previous code lost most of them and 500'd, current code lands all 20.

- **#2 Agent subprocess fragility** ([redline#16](https://github.com/alevi/redline/pull/16)). Refactored the agent spawn in `cli.ts` into `spawnAgent()` with a capped restart loop: up to 5 restarts in a rolling 60s window, then logs and stops. Did not pursue `detached: true` (Bun.spawn doesn't support it) or moving off `claude -p` to the SDK (CLAUDE.md is firm — auth flows through the user's existing Claude Code session). Test infrastructure: a `REDLINE_AGENT_CRASH_FILE` env hook in `agent.ts` for deterministic single-crash forcing, and a `waitForAgentConnects(n)` test helper. Sanity-checked the new test fails without the restart logic before committing.

- **#5 Two-concurrent-Redlines crash investigation** ([redline#17](https://github.com/alevi/redline/pull/17)). Reproduced the M4 process-tree shape: every CLI inherits the harness's PGID by default, so a signal to the harness hits both sister sessions at once. Under SIGTERM both write result files cleanly thanks to the M3 synchronous-write path (verified under simultaneous delivery). Under SIGKILL no handler runs, but that's uncatchable. Decided not to add detach-on-spawn — Bun lacks the option, foreground semantics would change in unwanted ways, and SIGKILL would bypass it anyway. Findings live at [docs/investigations/m5-concurrent-crash.md](../investigations/m5-concurrent-crash.md).

Test count went from 69 → 75 across the planned items. Each fix shipped with a regression test that would have caught the bug before merging — the working rule held all the way through.

A sixth, unplanned item emerged from dogfooding the retro itself:

- **Revision-stalled watchdog** ([redline#18](https://github.com/alevi/redline/pull/18)). The very session opened to review this retro hung after Revise was clicked: round still resolved, no terminal event ever delivered, agent process alive but idle. First hypothesis was EPIPE from a bad `| head -30 &` launch pattern — empirically falsified (Bun silently no-ops broken-pipe writes; three reproductions of the user's exact conditions all completed cleanly). With the root cause unidentified after extensive investigation, shipped a symptom-level defense: a 3-minute server-side timer started on `/api/accept`, cleared by any of the three terminal events, that un-resolves the round and broadcasts `revision-stalled` if it expires. Brings the milestone test count to 77. Investigation notes and a diagnostic-info checklist for next time live in [docs/retro.md](../retro.md).

## What got harder than expected

**Stacked-PR rebases.** PR #14 was opened off the same `origin/main` commit as PR #13 (which was awaiting review). When #13 merged, rebasing #14 produced a conflict in `tests/integration.test.ts` — both branches had appended new tests in adjacent regions. The default mental shortcut "take HEAD" or "take incoming" was wrong: HEAD held the just-merged #13 tests, the incoming commit held the #1 test, and both were correct additions. I dropped the #3 tests on the first pass and only caught it because the post-rebase test count came out one short. The rule that emerged: when rebasing a stacked PR, conflict markers around appended-only regions almost always mean both sides contributed legitimate work. Resolution is concatenation, not selection. Verify by counting.

**Choosing the right reproduction signal.** For #2, the first crash hook fired on agent startup before the agent connected — so the test only ever saw one `[agent] connected` line (from the restart). The fix was to delay the crash so the original process connects first, then exits, then the restart connects. Two connection events, one assertion. Took two test runs to land on the right shape.

**Bun signal-delivery behavior.** The M3 retro had warned that Bun's `subprocess.kill(...)` doesn't deliver signals to registered JS handlers — but that turned out to be narrower than the cleaner story. The standalone `process.kill(pid, sig)` (a Node/Bun standard process API) DOES fire handlers, including under simultaneous delivery to two siblings. The new #5 test relies on this exactly. The M3 retro entry isn't wrong, just narrower than the cleaner truth — `proc.kill()` is the unreliable one.

## What we learned

**Concurrency bugs hide in plain sight in single-writer code.** The sidecar race wasn't subtle — every comment-creating endpoint did `loadSidecar → mutate → saveSidecar` with no locking — but it survived three milestones because manual testing never fires N requests fast enough to interleave them. The 20×-parallel-POST test in M4 surfaced it in seconds. The lesson is the same as M4's test-coverage finding: enumerated concurrency tests catch what experiential testing can't even attempt.

**Per-file mutex is the right granularity for Redline.** I considered an append-only event log (the alternative listed in the roadmap), but the existing on-disk format is good and the migration cost would have been steep. A per-file `Map<string, Promise>` chain serializes correctly, doesn't change the data model, and keeps the code legible. The hot path is one file at a time anyway — there's no contention story across files.

**"Investigation" can be a real M5 deliverable.** #5 was scoped as an investigation, not a fix, and the conclusion was "no fix needed." That's a legitimate outcome — capturing exit codes, PGID inheritance, signal-handler delivery in a written-down doc means we don't relitigate the question next time. The investigation also corrected the M3 retro's signal-delivery claim, which is the kind of thing only a fresh reproduction surfaces.

**Capped restart loops over indefinite ones.** The agent restart could have been an infinite loop, but a permanently-broken environment (e.g. claude CLI deauth, missing binary) shouldn't burn through CPU forever. 5 restarts in 60s gives transient blips room to recover while bounding the worst case. The cap also doubles as a signal — if you ever see "gave up" in the log, something structural is wrong.

## What we're carrying forward

Nothing structural. The followups bucket from M4 closed cleanly:

- #4 Multi-fragment selection anchors — explicitly out of scope for M5 (changes sidecar shape; earns its own scope when a real doc needs it).
- Phase 4 of test milestone (client JS extraction + browser tests) — also out of scope for M5; deferred to its own follow-on so the test buildout pays for the script-extraction refactor at the same time.

The retro entries promoted (or candidate-for-promotion) to Levi Studio canon:

- "Rebasing a stacked PR: both sides of the conflict often contain novel work" — `canon/docs/12-ai-workflow-patterns.md` candidate.
- "Watchdog over cause: when symptom recurrence is bounded, ship a timer-based recovery without first pinning the root cause" — universal candidate; the cost (one timer + clear-on-success contract) is small enough that it's worth the default whenever a system can hang in unidentifiable ways.
- "process.kill(pid, sig) fires JS handlers; subproc.kill() doesn't" — corrects the M3 retro entry; might be too Bun-specific for canon.

M6 is next: load-bearing integration, getting Redline reached-for automatically across active projects.
