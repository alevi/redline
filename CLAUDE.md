# Redline — Claude Code compatibility

The canonical agent onboarding doc is [AGENTS.md](AGENTS.md). Read that file first; it is intentionally provider-neutral and applies to Claude Code, Codex, and any other agent working in this repository.

Claude-specific notes:

- Redline supports Claude Code through the `claude` provider in [src/agentProvider.ts](src/agentProvider.ts).
- Keep using the local `claude -p` CLI path for Claude support. Redline inherits the user's Claude Code auth session and does not require `ANTHROPIC_API_KEY`.
- Do not replace the local CLI provider with the Anthropic SDK unless the product direction explicitly changes. The local-agent auth model is load-bearing.
