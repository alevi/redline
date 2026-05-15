import { existsSync } from "fs";
import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import type { ModelTier } from "./pickModel";

export type AgentProviderId = "claude" | "codex";

export type RevisionChunkKind = "thinking" | "text";

export interface RevisionRunResult {
  revised: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface AgentProvider {
  id: AgentProviderId;
  displayName: string;
  executable(): string;
  preflight(): void;
  modelForTier(tier: ModelTier): string;
  runReply(input: {
    systemPrompt: string;
    userMessage: string;
    model: string;
    cwd: string;
  }): Promise<string>;
  runRevision(input: {
    systemPrompt: string;
    userMessage: string;
    model: string;
    cwd: string;
    onChunk?: (text: string, kind: RevisionChunkKind) => void;
  }): Promise<RevisionRunResult>;
}

export const PROVIDER_IDS: AgentProviderId[] = ["claude", "codex"];

export function parseAgentProviderId(value: string | undefined): AgentProviderId | null {
  if (!value) return null;
  return PROVIDER_IDS.includes(value as AgentProviderId) ? value as AgentProviderId : null;
}

export function resolveProviderId(raw?: string): AgentProviderId {
  const explicit = parseAgentProviderId(raw ?? process.env.REDLINE_AGENT);
  if (explicit) return explicit;

  if (process.env.CLAUDE_CODE_EXECPATH && existsSync(process.env.CLAUDE_CODE_EXECPATH)) return "claude";
  if (Bun.which("claude")) return "claude";
  if (process.env.CODEX_EXECPATH && existsSync(process.env.CODEX_EXECPATH)) return "codex";
  if (Bun.which("codex")) return "codex";
  // Preserve the published behavior: if nothing can be detected, the
  // preflight on the default provider prints the actionable install message.
  return "claude";
}

export function invalidProviderMessage(value: string): string {
  return `[redline] Unknown agent provider "${value}". Supported providers: ${PROVIDER_IDS.join(", ")}.`;
}

function requireExecutable(provider: AgentProviderId, envPath: string | undefined, bin: string): string {
  if (envPath && existsSync(envPath)) return envPath;
  const found = Bun.which(bin);
  if (found) return found;
  const install =
    provider === "claude"
      ? "Install Claude Code from https://claude.com/claude-code and re-run."
      : "Install Codex and make sure `codex` is on PATH, or set CODEX_EXECPATH.";
  throw new Error(
    `\n[redline] Could not find the ${provider} CLI.\n` +
    `Redline shells out to a local ${provider} agent for replies and revisions.\n` +
    `${install}\n`
  );
}

function drainStderr(stream: ReadableStream<Uint8Array>): Promise<string> {
  return (async () => {
    let out = "";
    const r = stream.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await r.read();
      if (done) break;
      const chunk = dec.decode(value);
      out += chunk;
      process.stderr.write(chunk);
    }
    return out;
  })();
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  let out = "";
  const r = stream.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await r.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

function combinedPrompt(systemPrompt: string, userMessage: string): string {
  return `${systemPrompt}\n\n---\n\n${userMessage}`;
}

export function getAgentProvider(id: AgentProviderId): AgentProvider {
  if (id === "codex") return codexProvider;
  return claudeProvider;
}

export const claudeProvider: AgentProvider = {
  id: "claude",
  displayName: "Claude",
  executable() {
    return requireExecutable("claude", process.env.CLAUDE_CODE_EXECPATH, "claude");
  },
  preflight() {
    this.executable();
  },
  modelForTier(tier) {
    return tier === "smart" ? "claude-sonnet-4-6" : "claude-haiku-4-5-20251001";
  },
  async runReply(input) {
    const proc = Bun.spawn(
      [this.executable(), "-p", "--system-prompt", input.systemPrompt, "--model", input.model],
      { stdin: "pipe", stdout: "pipe", stderr: "inherit", cwd: input.cwd }
    );
    proc.stdin.write(input.userMessage);
    proc.stdin.end();
    const reply = await readAll(proc.stdout);
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`claude CLI exited with code ${exitCode}`);
    return reply;
  },
  async runRevision(input) {
    const startedAt = Date.now();
    const proc = Bun.spawn(
      [this.executable(), "-p", "--system-prompt", input.systemPrompt, "--model", input.model,
       "--output-format", "stream-json", "--include-partial-messages", "--verbose"],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: input.cwd }
    );

    proc.stdin.write(input.userMessage);
    proc.stdin.end();

    const stderrDone = drainStderr(proc.stderr);
    let revised = "";
    let buffer = "";
    const reader = proc.stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === "stream_event" && obj.event?.type === "content_block_delta") {
            const delta = obj.event.delta;
            if (delta?.type === "text_delta" && delta.text) {
              revised += delta.text;
              process.stdout.write(delta.text);
              input.onChunk?.(delta.text, "text");
            } else if (delta?.type === "thinking_delta" && delta.thinking) {
              input.onChunk?.(delta.thinking, "thinking");
            }
          }
        } catch { /* malformed JSON line, skip */ }
      }
    }
    const exitCode = await proc.exited;
    const stderr = await stderrDone;
    return { revised, stderr, exitCode, durationMs: Date.now() - startedAt };
  },
};

export const codexProvider: AgentProvider = {
  id: "codex",
  displayName: "Codex",
  executable() {
    return requireExecutable("codex", process.env.CODEX_EXECPATH, "codex");
  },
  preflight() {
    this.executable();
  },
  modelForTier(tier) {
    return tier === "smart"
      ? (process.env.REDLINE_CODEX_SMART_MODEL ?? "gpt-5.4")
      : (process.env.REDLINE_CODEX_FAST_MODEL ?? "gpt-5.4-mini");
  },
  async runReply(input) {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "redline-codex-"));
    const lastMessagePath = path.join(tmpDir, "last-message.md");
    const proc = Bun.spawn(
      [
        this.executable(), "--ask-for-approval", "never", "exec",
        "--model", input.model,
        "--cd", input.cwd,
        "--sandbox", "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--color", "never",
        "--output-last-message", lastMessagePath,
        "-",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "inherit", cwd: input.cwd }
    );
    proc.stdin.write(combinedPrompt(input.systemPrompt, input.userMessage));
    proc.stdin.end();
    const stdout = await readAll(proc.stdout);
    const exitCode = await proc.exited;
    let reply = stdout;
    try {
      const fromFile = await readFile(lastMessagePath, "utf-8");
      if (fromFile.trim()) reply = fromFile;
    } catch { /* fall back to stdout */ }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    if (exitCode !== 0) throw new Error(`codex CLI exited with code ${exitCode}`);
    return reply;
  },
  async runRevision(input) {
    const startedAt = Date.now();
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "redline-codex-"));
    const lastMessagePath = path.join(tmpDir, "last-message.md");
    const proc = Bun.spawn(
      [
        this.executable(), "--ask-for-approval", "never", "exec",
        "--model", input.model,
        "--cd", input.cwd,
        "--sandbox", "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--color", "never",
        "--output-last-message", lastMessagePath,
        "-",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: input.cwd }
    );

    proc.stdin.write(combinedPrompt(input.systemPrompt, input.userMessage));
    proc.stdin.end();

    const stderrDone = drainStderr(proc.stderr);
    const stdoutDone = readAll(proc.stdout);
    const exitCode = await proc.exited;
    const [stderr, stdout] = await Promise.all([stderrDone, stdoutDone]);

    let revised = stdout;
    try {
      const fromFile = await readFile(lastMessagePath, "utf-8");
      if (fromFile.trim()) revised = fromFile;
    } catch { /* fall back to stdout */ }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});

    if (revised) {
      process.stdout.write(revised);
      input.onChunk?.(revised, "text");
    }
    return { revised, stderr, exitCode, durationMs: Date.now() - startedAt };
  },
};
