# Changelog

All notable changes to Redline are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Node-compatible launcher (`bin/redline.cjs`) so `npx @alevi/redline <file>` works alongside `bunx`.
- `ROADMAP.md` and this changelog.

### Changed
- Package renamed to scoped `@alevi/redline` for npm publishing.
- README rewritten around the AI-doc-review use case.

## [0.1.0] - 2026-05-09

Initial public release.

### Added
- Local review reader (Bun + Hono server, browser UI) for Markdown files.
- Inline select-to-comment with quote + 32-char-context anchoring.
- Sidecar JSON at `.review/<filename>.json` as the source of truth for a review.
- Per-round history snapshots at `.review/history/<file>.<iso>.md`.
- Real-time conversation with a Claude agent over SSE — the agent replies within seconds of a comment landing.
- Verdict-aware resolve: every agent reply ships with `requires_revision` so the round-level button auto-defaults to **Revise document** or **Accept as-is**.
- One-shot revision command: `redline resolve <file> [--model <id>]`.
- `redline-review` skill for outer-agent handoff (Claude Code etc.).
- CSRF token on every mutating `/api/*` request.
- Cross-process file lock around sidecar transactions.
- `realpath` check on the static-asset route to block symlink escapes.
- Per-prompt UUID envelopes around user-controlled prompt fields.
- Auto-restart of the agent subprocess (capped to 5 restarts / 60s).
- Auto-installs missing dependencies on first CLI run.
- Initial test suite: server, sidecar, parsing, model-picking, rendering, diff, SSE, integration, happy-dom client.

[Unreleased]: https://github.com/alevi/redline/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/alevi/redline/releases/tag/v0.1.0
