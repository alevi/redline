# Roadmap

## Milestones

Functional milestones for Redline. See `docs/studio-context.md` and `canon/docs/03-project-shape.md` for what a milestone is.

### M1: Single-pass review loop

- **Done when:** Agent writes a markdown file, a human comments inline in the browser, the agent reads and resolves the comments in one pass, and the document is regenerated. Round-trip works end-to-end.
- **Status:** reached
- **Retro:** retro entries already feeding canon (see commits `c2b408a`, `5499189`, `a5a1a2a` adding browser-UI patterns and async-indicator guidance to LeviStudio canon)

### M2: Multi-round revision cycles

- **Done when:** A review can span multiple rounds. Comments persist across rounds with status (open / resolved / superseded), the agent sees prior rounds when responding, and the human can sign off explicitly.
- **Status:** planned (explicitly post-v1 per `CLAUDE.md`)
- **Retro:**

### M3: Typed comment actions

- **Done when:** The comment grammar supports typed actions (`[expand]`, `[challenge]`, `[cut]`, …) derived from the natural taxonomy that emerged from real usage in M1/M2. Free text remains supported.
- **Status:** planned (waiting on real usage to inform the taxonomy)
- **Retro:**

## Now

What needs to happen immediately?

## Next

What follows after the first working slice?

## Later

What should wait until the product earns more scope?
