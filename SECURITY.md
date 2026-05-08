# Security

Redline is a **single-player, localhost-only** review tool that runs on the operator's machine. Reviewed Markdown is rendered in a browser and fed to a local Claude subprocess. This document describes what is defended against, what is out of scope, and how to report issues.

## Threat model

**In scope.** Two threats Redline actively defends against:

1. **Network exposure of the local server.** The server binds to `127.0.0.1` only — it is not reachable from other machines on the LAN, even when the user is on shared wifi. The printed `localhost` URL matches the actual bind.
2. **XSS via the rendered Markdown.** A reviewed `.md` may contain raw HTML, inline event handlers, or `javascript:`/`data:` URLs — these are stripped at the render boundary before the document reaches the browser. Sanitization covers both the main reader and the diff overlay.

**Out of scope.** Redline is a developer tool, not a sandbox. It is appropriate to run on documents you authored, generated, or trust. The following are **not** defended against:

- **Adversarial Markdown trying to manipulate the agent via prompt injection.** The agent reads the document text and comment thread as input to Claude; carefully crafted content can attempt to redirect the model. Treat agent output the same way you'd treat any other AI output you didn't fully verify.
- **Multiple `redline` processes operating on the same file.** The sidecar lock is in-process; concurrent runs on the same `.md` can corrupt review state.
- **Malicious CLI flags or environment.** `redline` runs with the operator's full file-system permissions and shells out to `claude -p` with the operator's auth.
- **Sharing reviews across operators.** Redline is single-player — it has no auth, no access control, and no audit log.

## What "single-player, localhost" means in practice

- Run Redline only on documents from sources you trust. The HTML render is sanitized; the content the agent ingests is not.
- Don't run Redline on a multi-user machine where another user has shell access — they could read the document directly from disk and connect to your loopback port.
- Don't expose the redline server through tunnels, reverse proxies, or `socat`. It assumes loopback semantics throughout.

## Reporting a vulnerability

If you find a security issue, please **do not** open a public issue. Use GitHub's [private vulnerability reporting](https://github.com/alevi/redline/security/advisories/new) — that opens a private channel for the report and a coordinated fix.

For non-security bugs, regular [issues](https://github.com/alevi/redline/issues) are the right place.

## Supported versions

Redline is built for the latest published `main`. There is no LTS branch and no backport policy — security fixes land on `main` and are picked up by re-pulling.
