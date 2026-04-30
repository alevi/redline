# M3 Retro: Resiliency pass

## What we shipped

Five items from the M3 scope, plus integration tests:

- **Auto-port.** Server now binds to port 0 (OS-assigned). `REDLINE_PORT` is passed to the agent subprocess via env so it doesn't need to know the port in advance.
- **Real bin entry.** `package.json` now has a `"bin"` field and `src/cli.ts` has a shebang. `bun link` produces a working global `redline` command. The skill's hardcoded fallback path is gone.
- **Comment-reply error logging.** `agent.ts` now logs failures to `.review/errors.log` in the same format as the resolve path. The `postAgentReplied()` call in the `finally` block is now non-throwing, so a failed POST can't leave thinking dots spinning.
- **Tab-close abandonment detection.** Server tracks browser SSE clients separately from the agent (via `?client=browser` query param). After the last browser disconnects and doesn't reconnect within 2 minutes (overridable via `REDLINE_ABANDON_MS`), the server fires an `onAbandon` callback and exits with code 2.
- **Result-file handoff.** Every exit path now writes `.review/<file>.result` as JSON before calling `process.exit`. The skill documents two invocation patterns: blocking (≤10 min) and polling (background + `until [ -f result ]`). The 10-minute Bash cap is no longer a hard ceiling on review length.
- **Integration tests.** Three automated tests covering auto-port, the abandon code path (via timer), and `/api/finish` → approved result file.

## What got harder than expected

One surprise: Bun subprocess signal delivery. When a parent process calls `proc.kill("SIGINT")` or `proc.kill("SIGTERM")` on a spawned subprocess, the OS terminates the child before the Bun event loop can invoke the JS signal handler. The result is exit code 130 or 143 (killed by signal) rather than 2 (from `process.exit(2)` in the handler).

This doesn't affect real-world usage — Ctrl+C in a terminal sends SIGINT to the foreground process group and the handler fires correctly. But it made the signal-path integration test unautomatable via `proc.kill()`. The fix for the production code: signal handlers now use synchronous `mkdirSync`/`writeFileSync` so the result file lands even if the async event loop is preempted. The test was dropped with a comment explaining the limitation.

## What we learned

Synchronous I/O in signal handlers is necessary. Async file writes in a signal handler have a race window: if the runtime terminates the process (for any reason) before the microtask queue drains, the write never lands. `writeFileSync` closes that window with one line.

The `onAbandon`/`onFinished` callback pattern was the right call for cross-layer communication. Alternatives — having the server call `process.exit()` directly, or using a shared module-level variable — would have made the CLI's exit paths harder to test and reason about.

## What we're carrying into M4

Nothing from M3. The three items I flagged but didn't scope in — sidecar atomicity, agent-crash browser banner, and stuck thinking dots on agent crash — are low urgency and fit better in M5 (UX polish).

M4 is typed comment actions. Real usage from M1/M2/M3 hasn't yet produced a natural taxonomy of action types, so M4 is still waiting on that signal.
