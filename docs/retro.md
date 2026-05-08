# Redline retro log

Running log per `canon/docs/13-retro-process.md`. Entries land here as work happens; canon proposals are reviewed at milestone close.

---

## 2026-05-07 — Canon proposal: Run the change before claiming it works

**Observation.** During the PID-wait fix ([redline#43](https://github.com/alevi/redline/pull/43)) I edited the redline-review skill, committed, opened the PR, and described the latency improvement to Alon — all without ever running the change. He asked "Did you test all of this?" and the honest answer was no. When I actually ran it after, the fix did work (~534ms vs. the up-to-30s claim), but that was luck of the easy case, not validation. The same shape recurs: agent reads the diff, concludes "this looks right," ships. The gap between mental model and runtime is exactly where the failures hide — process boundaries, subprocess lifecycle, IPC, env differences — and is invisible from the diff alone.

**Proposed canon change.** Add a new top-level section to `canon/docs/15-agent-collaboration.md` (after "Commands that live on a branch or worktree") titled **Run the change before claiming it works**. Content: before claiming a code change works, opening a PR, or describing the new behavior, the agent must exercise the change end-to-end at least once. Acceptable forms: a unit/integration test, a real run with a curl + assertion, a manual end-to-end session, or (for visual fixes) an old-vs-new harness with metrics reported in chat before pointing the human at the artifact. Not acceptable: "the code path looks right." If a real run isn't possible, say so explicitly instead of letting silence imply "tested." Full proposed wording surfaced inline in the conversation that produced this entry.

**Why universal.** Every Levi Studio project that uses coding agents hits this exact failure mode — a confident-looking diff that the agent never ran. Cost per instance is small but corrosive: each unverified PR costs Alon a round-trip to ask "did you test this?" The trust budget is finite. The rule is portable across runtimes, languages, and project shapes — it's about agent self-discipline, not project specifics.

**Status.** Accepted — merged in [levi-studio#21](https://github.com/alevi/levi-studio/pull/21) (2026-05-07).

---

## 2026-05-07 — Patch close: bottom-of-doc round-action mirror

- **What shipped.** A second copy of the round-level primary action (Revise document / Accept as-is / Accept doc) and its secondary "or …" link now sit at the foot of the document, below the prose article. `applyRoundState` still drives the top button as the source of truth and a new `syncBottomRoundActions()` mirrors text/disabled/mode/tint and the optional secondary onto the bottom; the bottom mirror auto-hides once the top collapses to `✓ Accepted` / `✓ Done` so it doesn't read as a stale control. Edits in [src/server.ts](src/server.ts) (markup + footer styling) and [src/client/main.js](src/client/main.js) (sync + click handler).
- **What surprised.** The "doc-shaped surface" mental model had been pulling the round controls toward the document header from the start, but the cost of that placement only surfaces once a doc is long enough that you've forgotten the header exists. A reading surface needs decisions to be reachable from where the reader actually lands — which is rarely the top.
- **Worth promoting to canon (revisit at next milestone close).** *For long reading surfaces with a header-anchored primary action, mirror the action at the foot of the content.* Generalizes beyond Redline (any review/approval surface where the reader scrolls through the artifact before deciding). The mirror should be driven from the canonical control, not duplicated state, and should fade once the action is no longer available so it doesn't look like a second chance. Could fit `canon/docs/09-product-ui-defaults.md`. Saved here as a project-level note in the meantime.
- **Verification.** `syncBottomRoundActions` was extracted from the bundle into [src/client/lib.ts](src/client/lib.ts) (same pattern as the rest of the pure-helper split) and covered by eight happy-dom tests in [src/client/lib.test.ts](src/client/lib.test.ts) — text/disabled/mode/tint mirroring, terminal-state collapse, stale-tint clearing, secondary clone with id remap, click-forwarding to the canonical top secondary, no-secondary clearing, and the read-only no-op path. Full suite: 150/150. Manual click-through in the reader still pending — flagging per the run-before-claiming-it-works canon rule.

---

## 2026-05-07 — Patch close: delimiter envelope for agent replies

**What shipped.** [src/agent.ts](src/agent.ts) and [src/parseReply.ts](src/parseReply.ts) no longer use a JSON contract for replies. The agent now emits `REQUIRES_REVISION: <bool>` / `REASON: <line>` headers followed by `---MESSAGE---` / `---END---` delimiters around the free-form prose. `parseReply` tries the delimiter form first and falls back to the JSON path so older traces and tests keep working. New unit tests in [tests/parseReply.test.ts](tests/parseReply.test.ts) cover the format including the original failure mode; new integration tests in [tests/agent.test.ts](tests/agent.test.ts) round-trip the envelope end-to-end through the agent and into the sidecar. Shipped in [redline#42](https://github.com/alevi/redline/pull/42).

**What surprised.** The bug was visible in the dogfooding tab — a reply rendered as ` ```json { "message": "...titled \"Frontend gotchas (paid in blood)\"...", ...} ``` ` with a warm "Resolve → queue edit" button it shouldn't have had. Two separate signals from the same root cause: the verbatim envelope blob, *and* the verdict button defaulting to "revise" instead of the "accept" the model actually chose. Both came from `parseReply` hitting its safe-default fallback (raw text + `requires_revision: true`). Worth noting because the asymmetric-status-as-signal canon (from M5_P1) was load-bearing in the *opposite* direction here: a defensive default that protects against silent skips also makes parse failures look like real "needs revision" verdicts. The right fix wasn't to soften the default — it was to remove the failure mode entirely by picking a serialization the model can't get wrong.

**Worth promoting to canon (revisit at next milestone close).** *When the model owns a structured reply, prefer a delimiter envelope to JSON for any free-form prose field.* JSON requires the model to escape every quote, every newline, every backslash inside the prose; delimiter envelopes need it to do nothing except not type the marker string. The cost is parser flexibility (no nested structures), which doesn't apply when the structured fields are scalars next to one prose blob. Could fit `canon/docs/12-ai-workflow-patterns.md`. Saved as a project-level memory in the meantime.

---

## 2026-05-07 — Fix close: 30s polling lag between human Accept and calling-agent wake

- **What broke.** After clicking Accept doc / Done in the reader, control didn't return to the calling Claude Code session for up to 30 seconds. Long enough to interrupt flow back to the terminal.
- **Root cause.** The redline-review skill's outer-agent wait loop used `until [ -f "$RESULT" ]; do sleep 30; done` — coarse file-existence polling on a 30s tick. The redline server itself exits cleanly within ~500ms of `/api/finish` (writes the `.result` file, fires `onFinished`, `process.exit(0)`); the lag was entirely in the calling session's polling cadence, not the server.
- **What prevents recurrence.** Skill now waits on the redline process directly via the `pid` already exposed in `.review/<file>.startup.json`: `while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done`. `kill -0` is a signal-permission check, essentially free, so a 0.5s tick is fine. Latency: up-to-30s → ≤0.5s. Edits in [skills/redline-review/SKILL.md](skills/redline-review/SKILL.md) (source of truth — `scripts/install-skill.sh` re-copies into `~/.claude/skills/`). Same edits applied to the installed copy so the win lands without a re-install.

---

## 2026-05-07 — Fix close: zombie SSE missed `reload` after long revision

**What broke.** Reviewer left comments on a doc in a sibling project, clicked "Revise document," waited ~2:40 for the revision to complete. File was rewritten on disk and a new round was opened in the sidecar — but the browser tab kept showing the old document until a manual hard-refresh. The server-side flow was clean; `event: reload` was broadcast on `/api/reload` exactly as designed.

**Root cause.** Zombie EventSource. During a long revision the tab was likely backgrounded/throttled; when the connection became silently un-deliverable, neither `onerror` nor any other handler fired on the client. The existing recovery path ([src/client/main.js:1186-1188](src/client/main.js:1186-1188)) only runs on `onopen` after a reconnect — and a zombie never reconnects because it never errors. Every layer assumed `onerror` would tell us when the stream went dead. When it doesn't, the reload event is lost forever.

**What prevents recurrence.** Two layered defenses in [src/client/main.js](src/client/main.js): (1) `visibilitychange` + `focus` listeners that run `softRefresh({rehighlight:true})` whenever the tab regains attention — softRefresh's `totalRounds` check then full-reloads if a `reload` was missed during the backgrounded interval; (2) a heartbeat watchdog (5s tick) that, while the `.revising` banner is showing, force-closes the EventSource if no event has arrived for >30s — reliable because the server streams `revision-chunk` events constantly during revision, so 30s of silence is unambiguously a dead connection. Conservative by design: idle sessions don't churn connections because the watchdog only fires while we're actively expecting events. Shipped in [redline#41](https://github.com/alevi/redline/pull/41).

---

## 2026-05-07 — Fix: coarse compare-with-previous diffs

- **What broke.** "Compare with previous" rendered any sentence-level rewording as a wall of green followed by a wall of red instead of inline word-level edits. On a representative RFC-style revision, 14 paragraph-sized red/green chunks with zero word marks. Visually you could see *that* something changed; you could not see *what*.
- **Root cause.** Two compounding things in [src/server.ts](src/server.ts)'s old `renderDocDiff`. (1) The merger only collapsed *adjacent* `delete`+`insert` pairs into a word-level modify. (2) LCS over paragraph blocks, when consecutive paragraphs share little verbatim text, produces all `insert`s ahead of all `delete`s rather than alternating — so the adjacent-only merger almost never fired in the realistic case (multiple reworded paragraphs in a row).
- **What prevents recurrence.** Diff logic moved to [src/diff.ts](src/diff.ts) with [src/diff.test.ts](src/diff.test.ts) (8 tests, including the multi-paragraph rewording case that triggered this). Pairs `delete`+`insert` inside any non-equal run by Jaccard similarity over normalized word tokens (greedy best-first, threshold 0.25). Genuinely new or removed paragraphs stay as pure add/remove blocks. [scripts/diff-compare.ts](../scripts/diff-compare.ts) renders both algorithms side-by-side so the threshold can be re-tuned against real before/after pairs without guessing. Shipped in [redline#40](https://github.com/alevi/redline/pull/40).

---

## 2026-05-06 — M7 close: client-side test coverage

**What shipped.** The 1430-line `<script>` body that lived inside `pageTemplate()` in [src/server.ts](src/server.ts) is now [src/client/main.js](src/client/main.js), bundled once at server startup with `Bun.build` and served from memory at `/client.js`. Server-side state moved to a tiny `window.__REDLINE__` bootstrap injected ahead of the bundle. The pure-ish helpers — `escapeHtml`, `latestVerdict`, `nearestCell`, `clampRangeToCell`, `captureSelection`, `highlightText`, `computeNavState`, `preserveScroll` — were lifted into [src/client/lib.ts](src/client/lib.ts) and `main.js` re-imports them. 26 new happy-dom tests in [src/client/lib.test.ts](src/client/lib.test.ts) cover every interaction the M4 retro flagged as test-blocking. Total test count went from 101 to 127. `src/server.ts` shrank from 3035 lines to ~1620.

**What surprised.** Three things.

The mechanical extraction was easier than scoped. A one-shot script ([scripts/extract-client.ts](scripts/extract-client.ts)) walked lines 1604–3031 of `server.ts`, undid two layers of template-literal escaping (`\${` → `${`, `\\` → `\`, `` \` `` → `` ` ``), and routed the four real interpolations (`${commentsJson}`, `${roundResolved}`, `${totalRounds}`, `${JSON.stringify(title)}`) through `window.__REDLINE__`. The whole conversion was ~25 lines and ran clean on the first try. Worth keeping the script in the repo — it's documentation of the migration even though it'll never run again.

`new Window()` from `happy-dom@20` doesn't fully initialize. `typeof w.SyntaxError` was `undefined` even though `Object.getOwnPropertyNames(w)` listed it. This silently broke any test that touched `querySelector`/`closest` (those internally do `new this.window.SyntaxError(...)` to throw on bad selectors, and the constructor was missing). The fix was to switch to `@happy-dom/global-registrator` — register globals once in `beforeAll`, write tests against the real `window`/`document`. Same library, different entry point, completely different reliability. Worth flagging because the failure mode looks like a bug in the helper under test, not a bug in the test environment.

The two-file split (lib.ts vs main.js) was the right shape. The pull was: do I write a parallel set of helpers in lib.ts and accept drift, or refactor main.js to import from lib? Refactoring won — lib.ts is the only definition of each helper, and main.js is the wiring layer that owns the side-effectful bits (click handlers, global state, the `deliberateScrollUntil` timer). `highlightText` is the one place where this split paid off cleanly: lib's version returns the marks, main.js's wrapper attaches the event listeners that need to call `focusComment`/`updateNav` — which the test surface should have no opinion on.

**The bundle-build cost.** Server startup grew from ~200ms to ~220ms in the smoke test — `Bun.build` itself is ~50–100ms, but it now runs lazily on the first request to `/client.js`, so the wall-clock cost shows up as a slightly slower first page load, not a slower CLI start. Caching the bundle to disk keyed on source mtime would eliminate the cost entirely on warm starts; pulled into M10 (Performance pass) rather than addressed here. The hit only stings during Redline-on-Redline development where the server restarts often; in normal use the build runs once per session.

**The test-script gap, finally fixed.** `package.json`'s `"test": "bun test tests/"` was only running 7 of the 11 test files in the repo — `src/render.test.ts`, `src/pickModel.test.ts`, `src/sidecar.test.ts`, and now `src/client/lib.test.ts` were silently skipped because they live next to their source files, not under `tests/`. Tightened the script to `bun test` (no path) so all 127 tests run. Pre-existing oversight; M7 made it visible because the new test file would have been silently skipped.

**Worth promoting to canon (revisit at next close).**

> **Pattern: pure helpers in their own module, wiring in the bundle entry point.** When extracting a fat browser script for testability, don't try to test the whole thing — split out the leaf-pure functions (DOM read/write that takes its container as an argument, no hardcoded `getElementById` calls, no closure references to UI state) into their own typed module, and let the entry point keep the side-effectful wiring (event listeners, globals, framework hooks). The tested surface is the lib; the wired UI lives next to its concerns. Same shape Redline already used for `sidecar.ts` vs `server.ts` on the server side — turning out to apply identically on the client side. Could fit a "code organization for test boundaries" entry in `canon/docs/`. Saved as project memory in the meantime.

> **Default to building+serving from memory for local dev tools, not a precomputed `dist/`.** Trade ~100ms of cold-start for zero "did I rebuild" friction. The `Bun.build` API makes this a 10-line function. Add an on-disk cache only when measurement says you need it. Aligns with Redline's existing "single binary, no setup steps" character — adding a `dist/` to gitignore + a build step + a "did you rebuild?" gotcha would have been a quiet regression in tool ergonomics. Worth a one-liner in `canon/docs/09-product-ui-defaults.md` or wherever local-CLI conventions land.

---

## 2026-05-04 — M6 close: load-bearing integration

**What shipped.** Redline is now reachable as a global skill from any Claude Code session, agents reach for it automatically when they produce a Markdown doc that needs sign-off, and the invocation flow works end-to-end with no manual nudges. The four work items: skill docs ([#26](https://github.com/alevi/redline/pull/26)), global install + script ([#27](https://github.com/alevi/redline/pull/27)), terse global `~/.claude/CLAUDE.md` rule, and two organic outside-redline validations.

The skill on `main` after #27 actually didn't work — the third commit on that PR (`startup.json` + skill-flow rewrite) didn't make it into the merge because GitHub merged the bottom of the stack before my third push landed. The fix shipped in [#31](https://github.com/alevi/redline/pull/31). Two PATH-related gaps showed up only when an outside session tried to invoke the skill (the redline binary's `bun` shebang, the `~/.bun/bin` directory not being on `$PATH` in non-interactive Bash subprocesses): both fixed in [#29](https://github.com/alevi/redline/pull/29) by generating a self-contained launcher with absolute paths to `bun` and `cli.ts` baked in. Net effect: zero PATH dependency anywhere in the chain.

**Validation 1: surfaced 5 product bugs in one sitting.** First real outside-redline use was a full review of a drift-report M1 prep doc with multiple rounds of comments. Surfaced bugs across the entire flow: `parseReply` leaking the JSON envelope on model-overruns ([#32](https://github.com/alevi/redline/pull/32)), focus stealing while typing across SSE-driven sidebar rebuilds ([#36](https://github.com/alevi/redline/pull/36)), card overlap on async content settle ([#35](https://github.com/alevi/redline/pull/35)), stale verdict footer on superseded agent replies ([#34](https://github.com/alevi/redline/pull/34)), table-cell selection rejecting overshoots that should have clamped ([#33](https://github.com/alevi/redline/pull/33)). All five shipped before validation 2.

**Validation 2: clean accept-doc flow.** Second session, agent reached for `redline-review` automatically, human had no feedback to give and took the "Accept doc" path (renamed from "Skip review" in [#30](https://github.com/alevi/redline/pull/30) after validation 1 surfaced that "Skip review" suggested bailing, not affirmative sign-off). End to end with no friction — exactly the integration M6 was aiming for.

**The polish-forces-end-to-end pattern, restated.** M4 retro called this out: polish forces you to experience the product as a user, which surfaces issues that reading code can't. M6 validation made it sharper: putting the product into another agent's hands forces the *whole flow* through a fresh nervous system. Five distinct bugs in one sitting, none of which I'd have caught reviewing my own usage. The skill-as-distribution-mechanism is itself a polish-forcer for the underlying tool.

**Stacked-PR merge order, again.** Same lesson as the M5 entry — PR #29 was created with PR #26's branch as its base, and when #26 merged first, my subsequent push to #29 landed on a now-stale base, so the merge moved a stale commit and the latest fix never reached `main`. Fixed via cherry-pick into [#31](https://github.com/alevi/redline/pull/31). The memory entry from the M6 prep already captured this; this is its second occurrence in two weeks. Worth re-emphasizing: when stacking PRs, the safe move is *always* (a) wait for the bottom to land, then re-target the top's base to main, or (b) accept noisier diffs and base both on main from the start.

**Local environment friction worth recording.** Twice during this work, my SSH-agent (1Password) flake-failed on commit signing and on `git push`. Recovery was a polite ask + retry; the alternative would have been `--no-gpg-sign` which my global rules block without explicit user consent. The flake doesn't justify a permanent workaround, but if it recurs across more sessions, building a `git-with-retry` shim is worth considering.

**Canon proposal — ready for promotion.**

> **Pattern: make a project's tool the default reach for AI agents in other projects.** When a project produces a tool whose value depends on agents reaching for it automatically across other projects, ship it as three coordinated artifacts:
>
> 1. A **global skill** at `~/.claude/skills/<name>/` so the skill is visible to any Claude Code session regardless of working directory.
> 2. An **in-repo install script** that copies (does not symlink) the skill into `~/.claude/skills/`. Symlinks break when the source repo moves between worktrees or paths; a copy that needs an explicit refresh is the lesser evil. The install script also generates a self-contained launcher with absolute paths to any required runtime (e.g. `bun`) and entry point (e.g. `cli.ts`) baked in — never trust `$PATH` to be the same in non-interactive subprocesses as in the user's interactive shell.
> 3. A **terse global `~/.claude/CLAUDE.md` rule** that delegates everything else to the skill. Two sentences max — skill content lives in `SKILL.md`, not in `CLAUDE.md`.
>
> The skill description (the YAML frontmatter, not the body) is what determines whether agents reach for it; tune that wording specifically for the trigger conditions you want.
>
> Validation requires *organic* outside-source-project use, not manufactured tests. Manufactured validation tests the install path, not whether agents will actually reach for the tool when it matters. Wait for two real triggers and observe what happens.

Suggested target: `canon/docs/12-ai-workflow-patterns.md`. The Redline-specific implementation details (launcher script, startup.json, etc.) stay in this repo; canon captures the pattern alone.

---

## 2026-05-03 — M6 items 1–3: making redline reachable from any project

**What shipped.** Three small things that together turn redline from "a tool I have to remember to use" into "a tool other-project agents reach for on their own":
1. `redline-review` skill updated ([redline#26](https://github.com/alevi/redline/pull/26)) to document the `--context` flag and the full outer-agent handoff loop. Also synced with two shipped behaviors the skill text predated: verdict-aware approval (an approved file may be byte-identical to the handoff if every comment was Q&A — that's not a no-op) and no-auto-open (the agent must surface the URL in its text output, since stolen-focus is no longer the signal).
2. `scripts/install-skill.sh` ([redline#27](https://github.com/alevi/redline/pull/27)) copies `skills/redline-review/` into `~/.claude/skills/` so the skill is visible from any working directory.
3. Two-sentence rule added to `~/.claude/CLAUDE.md`: when producing a Markdown doc that needs sign-off, reach for `redline-review` instead of pasting inline or just linking the file.

**Stacked PR mishap worth noting.** I created #27 with #26 as its base. The user merged #26 first; that fast-forwarded `main` to the skill-docs commit but left #27's content sitting on the now-stale `m6/skill-docs` branch. When #27 then merged into that branch, GitHub reported it as merged — but `main` never received the install-script commit. Caught when the worktree synced and `scripts/` was missing. Fixed with a cherry-pick onto a fresh PR.

The lesson: **stacking PRs onto a non-main base means the merge order matters and "merged" in the GitHub UI doesn't imply "on main."** When stacking, either (a) hold the bottom PR until the top one merges and use main as the base for both, or (b) after merging the bottom, re-target the top PR's base to main before merging.

**Copy-not-symlink for the skill install.** The repo lives in worktree paths that move and rename. A symlink from `~/.claude/skills/redline-review` into a worktree would break the moment the worktree is cleaned up; a stale dangling symlink is worse than a copy that needs an explicit re-run after pulling skill changes. The install script makes the refresh step a documented one-liner rather than a "remember the path" problem.

**Why M6 isn't done yet.** The whole thesis — "publish a project's tool as a global skill + a 2-sentence CLAUDE.md rule, and other-project agents will reach for it automatically" — is unproven until two organic, outside-redline doc tasks come up and either (a) the agent reaches for redline on its own or (b) the human notices the agent didn't and corrects it. Manufacturing validation tasks would defeat the point. Item 4 stays open until that happens naturally.

**Candidate canon (hold until M6 closes).** If the validation works, the cross-project lesson is worth canonizing: *to make a project's tool the default reach for AI agents in other projects, ship it as a global skill (copied via an in-repo install script, not symlinked) and add a terse global CLAUDE.md rule that delegates everything else to the skill's SKILL.md*. Do not propose to canon yet — promote only if Item 4 confirms the pattern works.

---

## 2026-05-03 — Patch close: deferred browser open

**What shipped.** `redline <file>` no longer spawns `open` / `xdg-open` on launch. The terminal prints the `localhost:<port>` URL with a "cmd-click when you're ready" nudge; pass `--open` to restore the old auto-open behavior. The `REDLINE_NO_OPEN` env var (an M3-era test escape hatch) is removed since the new default matches what tests wanted, and `tests/helpers.ts` got simpler. README updated. Shipped in [redline#23](https://github.com/alevi/redline/pull/23).

**What surprised.** Nothing during implementation — change was as local as the spec predicted (one flag, three lines in `cli.ts`, banner copy tweak). The interesting moment was upstream: the spec write-up flagged that the M3-era abandonment timer at `src/server.ts:48` only arms after `hadBrowser` becomes true, so a session where the user never clicks doesn't self-terminate. That arm-on-first-connect choice was made for a different reason during M3 (avoid 2-min grace tripping on DevTools-offline tests in M5 #1) but turns out to be exactly the right behavior for a default-no-open world. Worth noting that defensive design choices made for one reason can turn out to be load-bearing for an unrelated future change.

**Worth promoting to canon (revisit at next milestone close).** "For local CLIs that serve a browser UI, default to print-URL-don't-open; offer `--open` as opt-in." This matters more than it looks: the same default is correct for outer-agent invocations (M6 territory — there may be no GUI session at all), so the rule is robust across both interactive and non-interactive callers. Could fit `canon/docs/09-product-ui-defaults.md` or a new CLI-conventions entry. Saved as a project-level memory in the meantime.

---

## 2026-05-03 — Patch close: M5_P1 verdict-aware resolve

**What shipped.** Every agent reply now carries a structured verdict (`requires_revision: true|false` + `reason`) returned via a JSON contract from `claude -p` and parsed in `src/parseReply.ts` with a safe-default fallback. The round-level button defaults to "Revise document" or "Accept as-is" based on the verdicts; the alternate is one click away as a secondary link with a `confirm()` warning when the human overrides "implies edits → skip revision." Per-reply ✎ footer with the edit reason, warm-tinted "Resolve → queue edit" button, post-resolve verdict badges. Verdict is agent-owned; disagreement flows through a follow-up reply, not a UI toggle. Shipped in [redline#22](https://github.com/alevi/redline/pull/22).

**What surprised.** First version showed both verdict states symmetrically — "✎ Will edit the doc: <reason>" *and* "💬 Answered here — no edit needed." under every reply. User pushed back immediately on visual noise: "this is good overall, but a little too verbose" and called out specific redundancy ("Will add a line 3" + "Will edit the doc: Add a third line..."). The fix wasn't to shorten the copy — it was to **drop the neutral-state footer entirely**. The plain Resolve button (no warm tint) and the absence of the ✎ marker were already the signal that nothing was queued. Asymmetry IS the signal; symmetric "and here's the *other* state" copy was load-bearing nothing. Same round caught a coupled bug: the agent's free-text reply was restating what the verdict footer would render — fixed by adding "don't say the same thing twice; the message engages, the reason describes the edit" with a bad/good example to the agent prompt.

**Worth promoting to canon (revisit at next milestone close).** Two adjacent observations:
1. *Asymmetry as signal in two-state status UIs.* When a UI surfaces one of two states, default to giving only the action-bearing state a visible treatment — its presence/absence is the signal. Saved as a project-level memory; could lift to `canon/docs/09-product-ui-defaults.md` if it generalizes.
2. *When the UI wraps an agent reply with structured metadata (badges, labels, footers), tell the agent not to restate that metadata in the message itself.* General prompt-engineering pattern for any agent whose output gets composed with rendered metadata. Could fit `canon/docs/12-ai-workflow-patterns.md`.

Holding both for milestone-close canon review per process.

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
