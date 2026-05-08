#!/usr/bin/env bun
// Test double for the `claude` CLI. Detects the two modes Redline uses:
//
//   Agent reply mode:  invoked WITHOUT --output-format stream-json.
//                      Reads stdin as the user message, writes a canned
//                      plain-text reply to stdout.
//
//   Revision mode:     invoked WITH --output-format stream-json. Reads
//                      stdin (which contains a <document>...</document>
//                      block), emits stream_event lines that encode the
//                      revised text as text_delta deltas — matching the
//                      shape resolve.ts parses.
//
// Behavior is controlled by env vars so each test can pick a scenario:
//
//   REDLINE_SHIM_REPLY="..."           Agent reply text. Default: "Got it."
//   REDLINE_SHIM_REVISION=modify       (default) appends a marker section to
//                                      the doc and streams it back.
//   REDLINE_SHIM_REVISION=no-changes   Streams the doc back unchanged →
//                                      exercises resolve.ts's no-op path.
//   REDLINE_SHIM_REVISION=fail         Exits non-zero with a stderr message.
//                                      Exercises the failure logging path.

const args = process.argv.slice(2);
const isStreamJson = args.includes("stream-json");

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { buf.set(c, offset); offset += c.length; }
  return new TextDecoder().decode(buf);
}

function emitTextDelta(text: string) {
  // Mirror the shape resolve.ts pulls from: stream_event with content_block_delta
  const obj = {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text },
    },
  };
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function extractDocument(input: string): string {
  const m = input.match(/<document>\n?([\s\S]*?)\n?<\/document>/);
  if (!m) return "";
  // Resolve.ts wraps the document body in a per-prompt envelope:
  // <<UNTRUSTED-{uuid}-document-START>>\n<doc>\n<<UNTRUSTED-{uuid}-document-END>>
  // A real model would output just the inner text per the system prompt; the
  // shim mirrors that by stripping the envelope before echoing.
  const inner = m[1];
  const env = inner.match(/^<<UNTRUSTED-[^>]+-document-START>>\n([\s\S]*?)\n<<UNTRUSTED-[^>]+-document-END>>$/);
  return env ? env[1] : inner;
}

async function main() {
  const input = await readStdin();

  if (!isStreamJson) {
    // Agent reply mode — plain text out
    const reply = process.env.REDLINE_SHIM_REPLY ?? "Got it.";
    process.stdout.write(reply);
    return;
  }

  // Revision mode — stream JSON deltas
  const mode = process.env.REDLINE_SHIM_REVISION ?? "modify";
  if (mode === "fail") {
    process.stderr.write("shim: forced failure\n");
    process.exit(1);
  }

  const doc = extractDocument(input);
  if (!doc) {
    process.stderr.write("shim: no <document> in input\n");
    process.exit(2);
  }

  let revised: string;
  if (mode === "no-changes") {
    revised = doc;
  } else {
    revised = doc.trimEnd() + "\n\n## Revised by shim\n\nThis section was added by the test claude-shim.\n";
  }

  // Stream in two chunks so the broadcast path also gets exercised
  const half = Math.floor(revised.length / 2);
  emitTextDelta(revised.slice(0, half));
  emitTextDelta(revised.slice(half));
}

main().catch((e) => {
  process.stderr.write(`shim: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(3);
});
