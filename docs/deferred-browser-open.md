# Spec: Don't auto-open the browser

**Status:** planned (post-M5 patch)

## Problem

Today, `redline <file>` spawns the OS `open` command and the review tab takes focus
immediately. When the user is mid-context-switch — running redline from a script,
or kicking off a review while still working on something else — the surprise tab
steal is distracting. The session should be ready *when the user wants it*, not
the moment the process starts.

## Change

Stop auto-opening the browser by default. Print a clickable URL to the terminal
and let the user click it on their own schedule. This is the standard dev-server
pattern (Vite, Next, etc.).

### Default behavior (after this patch)

```
────────────────────────────────────────────────────────────
Redline review session
  File:   /path/to/spec.md
  URL:    http://localhost:54321
  Result: /path/to/.review/spec.md.result

  → cmd-click the URL when you're ready to review
────────────────────────────────────────────────────────────
```

No `open` / `start` / `xdg-open` spawn. Most modern terminals (iTerm2,
Terminal.app, VS Code, Ghostty, Warp) auto-linkify `http://` URLs.

### Flags

- `redline <file> --open` — opt back into the old auto-open behavior, for users
  or scripts that want it.
- The existing `REDLINE_NO_OPEN` env var becomes redundant and can be removed
  (or kept as a no-op for one release if anyone is depending on it — probably
  no one is).

## Implementation notes

The change is local to [src/cli.ts:162-167](src/cli.ts:162). Replace the
`if (!process.env.REDLINE_NO_OPEN)` block with a check on a parsed `--open`
flag, defaulting to false. Update the printed banner copy at
[src/cli.ts:54-61](src/cli.ts:54) to nudge the user toward the URL ("cmd-click
when you're ready").

The URL must be printed *after* `Bun.serve({ port: 0 })` returns the actual
bound port — the current code already does this correctly.

## Things considered

1. **Port collisions.** Already handled — `port: 0` lets the OS pick a free
   port and the printed URL reflects the real one.

2. **Abandonment timer.** The "no browser connected" grace timer at
   [src/server.ts:48-69](src/server.ts:48) only arms *after* `hadBrowser`
   becomes true. So a session where the user never opens the URL won't
   self-terminate — the process just waits. This is the right behavior for
   this change; nothing to do.

3. **The "Done" splash and clean exit rely on the tab being open.** A user who
   never opens the URL has to Ctrl-C to end the session. That already works
   (SIGINT → `abandon()` → result file written with `status: "abandoned"`).
   No new failure mode.

4. **Outer-agent handoff (M6 / `--context`).** When Redline is launched by
   another agent rather than a human at a terminal, auto-open is *especially*
   wrong — there may be no GUI session at all. This change fixes that for
   free. (If we later want to be smart, we could detect non-TTY stdin and
   skip the URL-printing nudge text, but that's polish, not required.)

5. **Cost clock.** The agent subprocess still spawns at CLI start, not at
   first browser connect. So Haiku/Sonnet token spend begins when you run
   `redline foo.md`, not when you click. Lazy-spawning the agent on first
   SSE connect is a bigger change with its own tradeoffs (longer time-to-
   first-reply when you do click) — out of scope for this patch.

6. **Memory.** This is a real preference shift. After it lands, save a
   feedback memory so it isn't silently reverted by a future "improvement"
   that re-adds auto-open.

## Out of scope

- Lazy agent spawn (see #5 above).
- Tray-icon / menubar notification when the URL is ready — terminals already
  surface the printed URL fine.
- Multiplexed sessions / port reuse — not relevant here.

## Done when

- `redline <file>` no longer steals focus.
- Printed URL is cmd-clickable from a default macOS terminal and from iTerm2.
- `redline <file> --open` restores the old behavior.
- The cli test (if there is one for this path) covers both the default and
  `--open` cases.
