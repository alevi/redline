# Changelog

All notable changes to Redline are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.0] - 2026-05-15

### Added
- Added author-handoff CLI commands: `redline author-needed <file>` lists pending author-needed comments, `redline author-reply <file> <comment-id> --message "..."` posts an author-marked reply back into the thread, and `redline author-wait <file>` blocks until either author input is needed or the review finishes.

### Changed
- Reframed M9 author handoff language from "escalated to the launching agent" to "author reply needed" while preserving the existing `ESCALATE`/`escalations` compatibility fields.

## [0.4.1] - 2026-05-15

### Fixed
- `redline-review` now launches Redline with `--open` so agent sessions open the review in the user's real browser instead of relying on clickable localhost links that some agent UIs capture in an embedded preview panel.

## [0.4.0] - 2026-05-15

### Added
- Claude and Codex agent providers are now supported through a provider-neutral runtime. Use `--agent claude|codex` or `REDLINE_AGENT` to choose explicitly; otherwise Redline auto-detects an available local provider.
- `redline install-skill --agent claude|codex|both` installs the bundled `redline-review` skill into Claude Code and/or Codex so agents can reach for Redline automatically when a Markdown doc needs human sign-off.

### Changed
- `AGENTS.md` is now the canonical contributor onboarding doc. `CLAUDE.md` remains as a Claude Code compatibility pointer to the same provider-neutral guidance.

## [0.3.0] - 2026-05-15

### Added
- **Escalation handoff** ([#86](https://github.com/alevi/redline/pull/86)). When a comment needs something the inline review agent can't provide — an external style guide, a spec it can't see, a decision that needs the wider project — the agent flags its reply with an escalate verdict. The comment shows an "Escalated" badge, the round banner notes the count, and the session's closeout summary and `.review/<file>.result` carry an `escalations` array so the agent that launched the review picks the feedback up.

### Fixed
- **Revision integrity check and retry** ([#86](https://github.com/alevi/redline/pull/86)). The revision pass now validates its output on every run and rejects a revision that silently drops document sections no comment touched, instead of writing a mangled document to disk. A failed validation retries once before surfacing an error.
- **Cross-block and image-spanning selections** ([#85](https://github.com/alevi/redline/pull/85)) now anchor correctly. Selecting across a block boundary, or across an image, no longer fails with an anchoring error.
- **Sessions are no longer abandoned on a transient SSE drop** ([#84](https://github.com/alevi/redline/pull/84)). A backgrounded tab, laptop sleep, or a brief network blip no longer causes the server to exit; only an explicit tab close ends the session. A server that does go away surfaces a clear "session ended" banner instead of a raw fetch error.

## [0.2.0] - 2026-05-11

### Added
- **Inline diff view** with a header toggle on revised rounds ([#79](https://github.com/alevi/redline/pull/79)). After a revision pass, the document opens with the diff rendered in place — block-level insert/delete bands and word-level marks for modified paragraphs. `Show changes` / `Hide changes` in the header flips between diff and clean view at any time. View choice persists per file in `sessionStorage`.
- **Markdown rendering in agent thread replies** ([#75](https://github.com/alevi/redline/pull/75)). Agent replies in the sidebar now render `**bold**`, lists, inline `code`, fenced blocks, and links instead of showing raw markdown. Same `marked` + `sanitize-html` pipeline as the document body.

### Changed
- **Doc header decluttered** ([#74](https://github.com/alevi/redline/pull/74)). `Compare with previous` moved out of the header and into the round-badge dropdown (only when there's a prior round to compare against). Filename no longer renders all-caps.
- **Banner hierarchy fixed** ([#77](https://github.com/alevi/redline/pull/77)). The reviewer's `--context` focus now reads at full document weight with a 3px accent stripe; the first-run safety notice is demoted to a muted inline line with an underlined "Got it" link. Importance now matches behavior: context shapes every reply for the session, the safety notice is once-per-machine.

### Fixed
- **Selections spanning a heading into a paragraph** ([#78](https://github.com/alevi/redline/pull/78)) are no longer rejected. The browser's `Selection.toString()` emits `\n\n` between blocks; `captureSelection` now normalizes those before searching the document text, and `highlightText` stores the normalized form so the highlight survives re-renders.
- Block-level deletes in the diff view now render with strikethrough (previously only word-level deletes inside modified paragraphs were struck through) ([#79](https://github.com/alevi/redline/pull/79)).

## [0.1.0] - 2026-05-11

Initial public release on npm as `@levistudio/redline`.

### Added
- Local review reader (Bun + Hono server, browser UI) for Markdown files.
- Inline select-to-comment with quote + 32-char-context anchoring.
- Sidecar JSON at `.review/<filename>.json` as the source of truth for a review.
- Per-round history snapshots at `.review/history/<file>.<iso>.md`.
- Real-time conversation with a Claude agent over SSE — the agent replies within seconds of a comment landing.
- Verdict-aware resolve: every agent reply ships with `requires_revision` so the round-level button auto-defaults to **Revise document** or **Accept as-is**.
- One-shot revision command: `redline resolve <file> [--model <id>]`.
- `redline-review` skill for outer-agent handoff (Claude Code etc.).
- Node-compatible launcher (`bin/redline.cjs`) so `npx @levistudio/redline <file>` works alongside `bunx`.
- `ROADMAP.md` and this changelog.
- CSRF token on every mutating `/api/*` request.
- Cross-process file lock around sidecar transactions.
- `realpath` check on the static-asset route to block symlink escapes.
- Per-prompt UUID envelopes around user-controlled prompt fields.
- Auto-restart of the agent subprocess (capped to 5 restarts / 60s).
- Auto-installs missing dependencies on first CLI run.
- Initial test suite: server, sidecar, parsing, model-picking, rendering, diff, SSE, integration, happy-dom client.

[Unreleased]: https://github.com/alevi/redline/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/alevi/redline/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/alevi/redline/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/alevi/redline/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/alevi/redline/releases/tag/v0.3.0
[0.2.0]: https://github.com/alevi/redline/releases/tag/v0.2.0
[0.1.0]: https://github.com/alevi/redline/releases/tag/v0.1.0
