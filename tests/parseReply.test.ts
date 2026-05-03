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
