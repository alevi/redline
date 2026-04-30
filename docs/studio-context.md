# Studio Context

> Canon source: `~/Projects/LeviStudio/canon/docs/`. Last synced: 2026-04-30.
>
> The section above `## Project-specific notes` is a synced index into Levi Studio canon. `LeviStudio/tools/refresh-canon.py` rewrites it on each sync — do not edit it here; local edits are overwritten. If something feels missing or wrong, log a `Canon proposal` entry in `docs/retro.md` (see `canon/docs/13-retro-process.md`).
>
> The section below the marker is project-specific and preserved across syncs. It is the document to read first when joining this project; canon docs above are reference material behind it.

## How to use canon

This project is a Levi Studio spin-off. Studio-wide guidance lives in `~/Projects/LeviStudio/canon/docs/`. The table below is an index, not a substitute — pull the actual doc when the situation matches a "read before" line. Do not paraphrase canon back into this repo; link to it.

## When to read what

| Doc | Read before… |
|---|---|
| 00-overview.md | …writing anything user-facing about what the studio is or why this project exists. |
| 01-brand.md | …naming, taglines, or any surface where the studio identity shows up. |
| 02-voice-and-writing.md | …writing copy, error messages, marketing pages, or PR descriptions meant for outside readers. |
| 03-project-shape.md | …deciding whether an idea belongs as a feature, a separate spin-off, or not at all; or naming a functional milestone. |
| 04-product-principles.md | …adding a feature, cutting a feature, or arguing about scope. |
| 05-design-direction.md | …design work on identity, marketing, or editorial surfaces. |
| 06-engineering-principles.md | …choosing a framework, library, datastore, or architectural pattern. |
| 07-launch-checklist.md | …calling something "ready to ship" or planning a public release. |
| 08-decision-rules.md | …you're stuck between two reasonable options and need a tie-breaker. |
| 09-product-ui-defaults.md | …building product UI, admin surfaces, or operational tools (palette, type, spacing, interaction defaults). |
| 10-shared-tools.md | …reaching for a utility that might already exist studio-wide. |
| 11-debugging-principles.md | …chasing a bug whose cause isn't obvious within ~15 minutes. |
| 12-ai-workflow-patterns.md | …designing any surface where an AI agent participates in real time. |
| 13-retro-process.md | …closing a milestone, finishing notable work, hitting a surprise worth recording, or proposing a canon change. |
| 14-spinoff-procedure.md | …a sub-project inside this repo starts feeling like its own thing. |

## Project-specific notes

> This section is the project's lived relationship with canon. It is preserved across canon syncs. Edit freely.

### Identity

- Project name: Redline
- Project type: tool
- One-line description: Local markdown inline commenting tool for AI agents

### What this project is, in canon terms

Redline is a **tool** in the `03-project-shape.md` sense — single-player, local, a small focused utility rather than a product with users to retain. The work canon is doing hardest here is `04-product-principles.md`'s "start narrow, let it earn complexity": the deliberate v1 scope is one round-trip review loop, not a multi-round commenting platform. Redline is also itself a substrate for studio AI workflows, so its real measure is whether it makes the human side of human-in-the-loop AI doc review feel light.

### Where canon lands hard

- **`04-product-principles.md` — start narrow.** M1 is a single round-trip; M2 (multi-round) and M3 (typed comment grammar) are explicitly held back until real M1 usage shapes them. The taxonomy of comment actions emerges from what people actually write, not what we guess.
- **`12-ai-workflow-patterns.md` — agent as participant.** Redline isn't an AI feature inside a product; it's the human side of an AI loop. Agent latency, partial states, and "what does the agent see when it reads back" are first-class UX questions, not afterthoughts.
- **`09-product-ui-defaults.md`** — the reader is product UI, not editorial. Prefer the product defaults (quiet density, sharp edges, restrained color) over a writerly tool feel.

### Where canon needs adapting

- Canon assumes most projects have an *audience*. Redline's only "user" today is the project owner; "marketing surface" guidance from `02-voice-and-writing.md` mostly doesn't apply. Anything user-visible is a CLI message or a local browser surface, not a public page.

### Project-specific commitments

- Single-player. No multi-user, no auth, no shared state in v1.
- Local-only. No hosted service, no telemetry, no cloud sync.
- Sidecar comments live next to the file, gitignore-friendly, never inside the source markdown.
- The agent handoff is convention-driven (a known sidecar shape), not a Redline-specific API the agent has to learn.
- No comment grammar in M1 — free text only. Typed actions wait until real usage suggests the right enum.

### Open questions canon doesn't answer yet

- How should canon describe "tools that exist to support studio AI workflows themselves"? The dogfood loop (Redline shapes how we use Claude on docs, which shapes Redline) is real but isn't a documented category.
