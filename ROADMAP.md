# Roadmap

This roadmap captures where Redline is heading. It's directional, not a commitment — items may move, drop, or arrive in a different shape based on what users actually hit. File an [issue](https://github.com/alevi/redline/issues) if any of this matters to you and you want to nudge the order.

## Now

- **Polished launch.** Scoped npm publish (`@alevi/redline`), `npx` / `bunx` parity, GitHub Release, demo GIF that captures the magic moment, landing page.
- **Stability under real workloads.** Long-document rendering, large sidecars, many-round sessions.

## Next

- **Folder / multi-doc review.** Open a directory, walk through Markdown files in sequence, share a single agent across the session.
- **Sharper diff overlay.** Per-paragraph applied-edit indicators in the post-revision view so you can see exactly which comments translated into which edits.
- **Comment templates.** Optional structured actions layered on top of free-text comments — `expand`, `challenge`, `cut`, `tighten` — so common requests don't need to be retyped each time.
- **Read-only share link.** Optional, opt-in, ephemeral — lets a teammate spectate a review without write access.
- **Editor integrations.** VS Code / Cursor / JetBrains panel that opens the review for the active Markdown file.

## Later / wishlist

- **Multi-reviewer mode.** Real names, threaded comments from multiple humans, conflict resolution. Big change to the threat model — explicitly out of scope for now.
- **Agent-side initiative.** The agent flags weak claims or missing sections proactively, instead of only responding to human comments.
- **Non-Markdown formats.** PRD review for `.docx` or `.pdf` is a separate product surface; not a near-term direction.

## Known limitations

These are intentional today. They're listed here so you can decide whether Redline fits before you try it.

- **Markdown only.** The renderer, the diff, and the agent prompts all assume Markdown.
- **Single-player.** No auth, no audit log, no concurrent reviewers. Designed for one human and one agent on a developer's laptop.
- **Single file per session.** Each `redline <file>` invocation tracks one document.
- **Local sidecar lock only.** Concurrent `redline` processes on the same `.md` can corrupt review state — don't run two sessions on the same file.
- **Bun-only at runtime.** The Node launcher exists for `npx` ergonomics, but Bun is required for the server to run.
- **Prompt injection in document content is not defended against.** Run on docs you trust.

## Want to influence the roadmap?

- Open an issue with the use case you have in mind. Concrete > abstract — "I want to redline a 12-doc spec folder before our quarterly planning" is more useful than "support folders".
- Comment on existing issues to upvote / disagree.
- For security issues, use [private vulnerability reporting](https://github.com/alevi/redline/security/advisories/new) instead of an issue.
