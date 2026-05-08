import { describe, expect, test } from "bun:test";
import {
  FAST_MODEL,
  SMART_MODEL,
  pickReplyModel,
  pickRevisionModel,
} from "./pickModel";

describe("pickReplyModel", () => {
  test("short confirmations get Haiku", () => {
    expect(pickReplyModel("yes")).toBe(FAST_MODEL);
    expect(pickReplyModel("good point")).toBe(FAST_MODEL);
    expect(pickReplyModel("let's do it")).toBe(FAST_MODEL);
    expect(pickReplyModel("make it 7")).toBe(FAST_MODEL);
  });

  test("any message containing a question mark gets Sonnet", () => {
    expect(pickReplyModel("ok?")).toBe(SMART_MODEL);
  });

  test("long messages get Sonnet regardless of content", () => {
    const long = "x".repeat(121);
    expect(pickReplyModel(long)).toBe(SMART_MODEL);
  });

  test("involved keywords promote to Sonnet", () => {
    expect(pickReplyModel("suggest an alternative")).toBe(SMART_MODEL);
    expect(pickReplyModel("how about something else")).toBe(SMART_MODEL);
    expect(pickReplyModel("could we propose another")).toBe(SMART_MODEL);
  });

  test("the keyword check is whole-word, not substring", () => {
    // "couldve" should not match the "could" pattern since it's not bounded
    expect(pickReplyModel("ok").length).toBeGreaterThan(0); // sanity
    // "should" matches; "shoulder" should not
    expect(pickReplyModel("a shoulder")).toBe(FAST_MODEL);
  });
});

describe("pickRevisionModel", () => {
  test("returns Haiku when every settled comment is simple", () => {
    const comments = [
      {
        thread: [
          { role: "human", message: "make it 7" },
          { role: "agent", message: "ok" },
          { role: "human", message: "yes good" },
        ],
      },
    ];
    expect(pickRevisionModel(comments)).toBe(FAST_MODEL);
  });

  test("a single involved keyword anywhere promotes the whole revision", () => {
    const comments = [
      { thread: [{ role: "human", message: "make it 7" }] },
      { thread: [{ role: "human", message: "rewrite this section" }] },
    ];
    expect(pickRevisionModel(comments)).toBe(SMART_MODEL);
  });

  test("a long human message anywhere promotes to Sonnet", () => {
    const long = "x".repeat(151);
    const comments = [
      { thread: [{ role: "human", message: "ok" }] },
      { thread: [{ role: "human", message: long }] },
    ];
    expect(pickRevisionModel(comments)).toBe(SMART_MODEL);
  });

  test("agent messages don't influence the picker", () => {
    const long = "x".repeat(200);
    const comments = [
      {
        thread: [
          { role: "human", message: "ok" },
          { role: "agent", message: long }, // long agent message — should be ignored
        ],
      },
    ];
    expect(pickRevisionModel(comments)).toBe(FAST_MODEL);
  });

  test("empty comment list returns Haiku", () => {
    expect(pickRevisionModel([])).toBe(FAST_MODEL);
  });

  test("revision keywords are different from reply keywords", () => {
    // 'rewrite' is a revision keyword but not a reply keyword
    expect(pickRevisionModel([{ thread: [{ role: "human", message: "rewrite" }] }])).toBe(SMART_MODEL);
    expect(pickReplyModel("rewrite")).toBe(FAST_MODEL);
  });
});
