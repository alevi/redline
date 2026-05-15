#!/usr/bin/env bun
// Test double for `codex exec`. It mirrors the same env-controlled behavior
// as claude-shim, but writes the final revision to --output-last-message when
// Redline asks for one.

import { readFileSync, writeFileSync } from "fs";

const args = process.argv.slice(2);

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { buf.set(c, offset); offset += c.length; }
  return new TextDecoder().decode(buf);
}

function argValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function extractDocument(input: string): string {
  const m = input.match(/<document>\n?([\s\S]*?)\n?<\/document>/);
  if (!m) return "";
  const inner = m[1];
  const env = inner.match(/^<<UNTRUSTED-[^>]+-document-START>>\n([\s\S]*?)\n<<UNTRUSTED-[^>]+-document-END>>$/);
  return env ? env[1] : inner;
}

function dropFirstHeading(md: string): string {
  return md.replace(/^#{1,6} .+\n*/m, "");
}

function bumpCounter(): number {
  const f = process.env.REDLINE_SHIM_COUNTER;
  if (!f) return 1;
  let n = 0;
  try { n = parseInt(readFileSync(f, "utf8").trim() || "0", 10) || 0; } catch {}
  n += 1;
  try { writeFileSync(f, String(n)); } catch {}
  return n;
}

async function main() {
  const input = await readStdin();
  const lastMessagePath = argValue("--output-last-message");

  const doc = extractDocument(input);
  if (!lastMessagePath || !doc) {
    const reply = process.env.REDLINE_SHIM_REPLY ?? "Got it.";
    if (lastMessagePath) writeFileSync(lastMessagePath, reply);
    process.stdout.write(reply);
    return;
  }

  const mode = process.env.REDLINE_SHIM_REVISION ?? "modify";
  if (mode === "fail") {
    process.stderr.write("codex shim: forced failure\n");
    process.exit(1);
  }

  const cleanRevision = doc.trimEnd() + "\n\n## Revised by codex shim\n\nThis section was added by the test codex-shim.\n";
  let revised: string;
  if (mode === "no-changes") {
    bumpCounter();
    revised = doc;
  } else if (mode === "mangle") {
    bumpCounter();
    revised = dropFirstHeading(doc);
  } else if (mode === "mangle-once") {
    revised = bumpCounter() === 1 ? dropFirstHeading(doc) : cleanRevision;
  } else {
    bumpCounter();
    revised = cleanRevision;
  }

  writeFileSync(lastMessagePath, revised);
  process.stdout.write(revised);
}

main().catch((e) => {
  process.stderr.write(`codex shim: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(3);
});
