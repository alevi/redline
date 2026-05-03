# M5 #5 — two-concurrent-Redlines crash investigation

**Verdict:** No fix needed. The symptom observed during M4 testing is no longer reproducible after the M5 fixes (#2 agent restart, #3 revision-error reporting, #6 sidecar mutex). The underlying process-group sharing is expected POSIX behavior; the previous bug was downstream — missing/wrong result files — and that path is now well-covered.

## What was reported

During M4 dogfooding, two concurrent Redline sessions running under the same outer harness both crashed at roughly the same time. The hypothesis logged in `docs/m4-polish-punch-list.md` (followup #5): harness-level process-group reaping was killing both at once.

## Reproduction

Two parallel reproductions captured the relevant facts.

**A. Process-tree shape.** Spawn two `bun run src/cli.ts` instances from a parent Bun script. After they're up, capture each CLI's PGID and child PIDs:

```
A: pid=52387 pgid=52382 agent=52390
B: pid=52388 pgid=52382 agent=52389
parent script: pid=52385 pgid=52382
bothInSameGroupAsMe: true
```

Confirmed: by default, every CLI inherits the parent's process group. A signal sent to that group hits all three (parent + both CLIs) plus their agent children.

**B. Signal behavior.** With two concurrent CLIs running, send `SIGTERM` to each:

```
A exit=2 B exit=2
[A] { "status": "abandoned", "file": "...test.md" }
[B] { "status": "abandoned", "file": "...test.md" }
```

Both sessions die cleanly. Both result files land. Exit code 2 (abandoned) on both — the M3 synchronous `writeFileSync` in the signal handler does its job, even when two signals arrive simultaneously across sibling processes.

With `SIGKILL` instead:

```
A exit=137 B exit=137
[A] NO RESULT FILE
[B] NO RESULT FILE
```

As expected — SIGKILL is uncatchable, so no handler runs. Exit 137 = `128 + 9`.

## What this means for the original report

Two interpretations of "both crashed at roughly the same time":

1. **Both got SIGTERM.** The result files would have landed at the time, but the surrounding M4 testing didn't yet differentiate "crashed without result file" from "exited via signal with result file." Looks like a crash from the user's perspective; isn't.
2. **Both got SIGKILL.** This is uncatchable. No result file. Looks like a hard crash because it is one. Mitigation belongs in the harness, not in Redline — send SIGTERM first, escalate to SIGKILL only after a grace period.

Either way, the per-session resilience story now has answers it didn't have during M4:

- **Result file always lands on SIGTERM** (M3, verified again here under concurrent delivery).
- **Agent crashes inside a session no longer kill the session** (#2 — auto-restart up to 5 in 60s).
- **Sidecar writes don't interleave** so a crash mid-write can't corrupt state (#6 — per-file mutex).
- **Revision crashes report `error`, not `abandoned`** so the calling agent can distinguish (#3).

## Why we're not detaching

A "real" fix would be for each CLI to call `setsid(2)` on startup, breaking out of the parent's process group so harness reaping doesn't kill it. We're not doing this:

- Bun.spawn doesn't expose a `detached: true` option, and there's no `process.setsid()` in Node/Bun's user-facing API. The clean path would be to re-exec with a wrapper, which complicates the lifecycle.
- The current behavior — children die with the harness — is what users expect from a foreground subprocess. Detaching would orphan Redline sessions when the harness exits, leaving zombie servers on random ports.
- The actual user-facing harm (no result file on hard reap) is bounded to SIGKILL, which detaching wouldn't prevent anyway.

If we ever need cross-harness session survival, the right shape is an opt-in `--detach` flag that uses `setsid` via shelling out, not changing the default.

## Recommendation for callers

Outer agents that spawn `redline` should send `SIGTERM` (not `SIGKILL`) when ending sessions, and wait at least a few hundred milliseconds for the synchronous result-file write to land before escalating. The M3 result-file pattern (poll the `.result` file) tolerates this naturally.
