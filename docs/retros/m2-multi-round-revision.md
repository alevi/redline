# M2 Retro: Multi-round revision cycles

## What we shipped

Multi-round review now works end-to-end. A reviewer can leave inline comments, the agent replies in real time, the human resolves comments and clicks "Revise document," the doc is rewritten, and a new round opens automatically. The session closes cleanly when the human clicks Done. The outer agent that launched the session can read a structured result line and exit code to know whether the doc was approved.

## What got harder than expected

Two surprises ate disproportionate time.

The first was a race in the client where `softRefresh` (async) clobbered an error banner that had just been set synchronously. Revision failures appeared for one frame and then vanished, leaving the user in a confusing state where the doc was unchanged but the UI implied success. The fix was a single guard in `applyRoundState` that skips banner mutations when an error is showing — but locating it took a careful read of the event ordering.

The second was Bun's default 10-second SSE idle timeout silently killing the agent connection mid-revision. The browser kept its connection alive (8s pings were added), but the server-side timeout still applied to the agent subprocess. Setting `idleTimeout: 0` on `Bun.serve` fixed it.

## What we learned

Streaming progress beats spinners. Showing the agent's thinking and document text scroll by during revision turned a 60-second blank wait into something that feels like work happening. Worth the implementation cost.

Errors must persist visibly. Any handler that calls `softRefresh()` followed by a synchronous UI update is racing — the rule is now: error banners survive softRefresh.

Process semantics are enough for cross-agent handoff. We considered hooks, webhooks, and IPC for "let the outer agent know the review is done." The answer turned out to be `redline <file>` is a blocking subprocess that exits with a structured result line. The outer agent's Bash call does the waiting.

## What we're carrying into M3

- Tab-close abandonment isn't detected. SIGINT works, but a closed browser tab leaves the server running indefinitely — and blocks the outer agent until the 10-minute Bash timeout fires. M3 should add a resume path: on startup, the outer agent's prompt should include the localhost URL so the reviewer has a clear breadcrumb to reopen the session if they navigate away.
- The 10-minute Bash timeout caps how long a review can take from a calling agent's perspective. Long reviews need a different mechanism — likely polling a result file (`.review/<file>.result`) rather than blocking on the process. *(M3: design the result-file handoff so the outer agent can `until [ -f result ]` instead of waiting on a subprocess.)*
- Error logging exists but only on the resolve path. Comment-reply failures still die quietly.