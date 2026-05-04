import { test, expect } from "bun:test";
import { parseReply } from "../src/parseReply";

test("parseReply: well-formed JSON with revise verdict", () => {
  const r = parseReply(JSON.stringify({
    message: "Will rephrase the intro.",
    requires_revision: true,
    reason: "drop the offline-first framing",
  }));
  expect(r).toEqual({
    message: "Will rephrase the intro.",
    requires_revision: true,
    reason: "drop the offline-first framing",
  });
});

test("parseReply: well-formed JSON with accept verdict", () => {
  const r = parseReply(JSON.stringify({
    message: "Yes, that's correct.",
    requires_revision: false,
    reason: "answered the clarifying question",
  }));
  expect(r.requires_revision).toBe(false);
  expect(r.message).toBe("Yes, that's correct.");
});

test("parseReply: unwraps ```json ... ``` code fence", () => {
  const r = parseReply('```json\n{"message":"ok","requires_revision":false,"reason":"approved"}\n```');
  expect(r.message).toBe("ok");
  expect(r.requires_revision).toBe(false);
});

test("parseReply: unwraps bare ``` code fence", () => {
  const r = parseReply('```\n{"message":"ok","requires_revision":true,"reason":"r"}\n```');
  expect(r.requires_revision).toBe(true);
});

test("parseReply: missing reason field defaults to empty string", () => {
  const r = parseReply('{"message":"ok","requires_revision":false}');
  expect(r.reason).toBe("");
});

test("parseReply: missing requires_revision defaults to true (safe default)", () => {
  const r = parseReply('{"message":"ok"}');
  expect(r.requires_revision).toBe(true);
});

test("parseReply: unparseable input falls back to raw text + requires_revision: true", () => {
  const r = parseReply("This is just prose, not JSON at all.");
  expect(r.message).toBe("This is just prose, not JSON at all.");
  expect(r.requires_revision).toBe(true);
  expect(r.reason).toBe("");
});

test("parseReply: JSON without message field falls back to raw", () => {
  const r = parseReply('{"requires_revision": false}');
  expect(r.requires_revision).toBe(true); // safe default kicks in
  expect(r.message).toBe('{"requires_revision": false}');
});

test("parseReply: trims whitespace around message and reason", () => {
  const r = parseReply('{"message":"  ok  ","requires_revision":true,"reason":"  why  "}');
  expect(r.message).toBe("ok");
  expect(r.reason).toBe("why");
});

test("parseReply: trailing text after envelope (model overrun) is discarded", () => {
  // Real failure mode observed in dogfood: agent emits a valid envelope, then
  // keeps generating, hallucinating the next prompt's structure ("Reviewer: …").
  // JSON.parse rejects the whole string; without recovery the raw fallback
  // dumped the JSON envelope verbatim into the rendered message AND lost the
  // verdict, defaulting to requires_revision: true.
  const raw = '{"message": "Agreed — that fits better.", "requires_revision": false, "reason": ""}\n\nReviewer: Can you add a note?';
  const r = parseReply(raw);
  expect(r.message).toBe("Agreed — that fits better.");
  expect(r.requires_revision).toBe(false);
  expect(r.reason).toBe("");
});

test("parseReply: leading text before envelope is also tolerated", () => {
  const raw = 'Sure thing. {"message":"ok","requires_revision":true,"reason":"r"}';
  const r = parseReply(raw);
  expect(r.message).toBe("ok");
  expect(r.requires_revision).toBe(true);
});

test("parseReply: nested braces inside message string don't break extraction", () => {
  // The brace-walker must respect string literals; otherwise a `}` inside a
  // quoted message would close the object early and the parse would fail.
  const raw = '{"message": "Use the form {a: 1, b: 2}.", "requires_revision": false, "reason": ""}\nstray';
  const r = parseReply(raw);
  expect(r.message).toBe("Use the form {a: 1, b: 2}.");
  expect(r.requires_revision).toBe(false);
});

test("parseReply: escaped quotes inside message don't fool the string-literal walker", () => {
  // \" inside a string must not terminate the string for brace counting.
  const raw = '{"message": "He said \\"yes\\" — done.", "requires_revision": false, "reason": ""} trailing';
  const r = parseReply(raw);
  expect(r.message).toBe('He said "yes" — done.');
  expect(r.requires_revision).toBe(false);
});
