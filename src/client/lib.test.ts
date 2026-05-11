import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  escapeHtml,
  latestVerdict,
  nearestCell,
  clampRangeToCell,
  captureSelection,
  highlightText,
  computeNavState,
  preserveScroll,
  type ClientComment,
} from "./lib";

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.innerHTML = "";
});

function setBody(html: string) {
  document.body.innerHTML = html;
}

describe("escapeHtml", () => {
  test("escapes the four html-significant chars", () => {
    expect(escapeHtml("a & b < c > d \" e")).toBe("a &amp; b &lt; c &gt; d &quot; e");
  });
  test("idempotent on benign input", () => {
    expect(escapeHtml("plain text 123")).toBe("plain text 123");
  });
});

describe("latestVerdict", () => {
  function makeComment(thread: any[]): ClientComment {
    return { id: "c1", quote: "x", resolved: false, thread };
  }
  test("returns null when no agent reply has a verdict", () => {
    expect(latestVerdict(makeComment([{ role: "human", message: "hi" }]))).toBeNull();
    expect(latestVerdict(makeComment([{ role: "agent", message: "no verdict" }]))).toBeNull();
  });
  test("returns latest agent verdict when present", () => {
    const c = makeComment([
      { role: "agent", message: "first", requires_revision: true },
      { role: "human", message: "ok" },
      { role: "agent", message: "second", requires_revision: false },
    ]);
    expect(latestVerdict(c)).toBe("accept");
  });
  test("ignores human entries when scanning", () => {
    const c = makeComment([
      { role: "agent", message: "a", requires_revision: true },
      { role: "human", message: "h" },
    ]);
    expect(latestVerdict(c)).toBe("revise");
  });
});

describe("nearestCell", () => {
  test("finds the enclosing td from a text node", () => {
    setBody("<table><tr><td id='c1'>hello</td><td id='c2'>world</td></tr></table>");
    const td1 = document.getElementById("c1")!;
    const text = td1.firstChild!;
    expect(nearestCell(text)).toBe(td1);
  });
  test("returns null outside any cell", () => {
    setBody("<p>plain text</p>");
    const p = document.querySelector("p")!;
    expect(nearestCell(p.firstChild!)).toBeNull();
  });
});

describe("clampRangeToCell", () => {
  test("clamps to the start cell when range crosses cell boundary", () => {
    setBody("<table><tr><td id='c1'>hello</td><td id='c2'>world</td></tr></table>");
    const c1 = document.getElementById("c1")!;
    const c2 = document.getElementById("c2")!;
    const r = document.createRange();
    r.setStart(c1.firstChild!, 1);
    r.setEnd(c2.firstChild!, 3);
    const clamped = clampRangeToCell(r, c1, c2, document);
    expect(clamped).not.toBeNull();
    // start preserved, end clamped to inside c1
    expect(clamped!.startContainer).toBe(c1.firstChild!);
    expect(clamped!.startOffset).toBe(1);
    // end is now inside c1 (not c2)
    expect(c1.contains(clamped!.endContainer)).toBe(true);
  });
  test("returns null when neither endpoint is in a cell", () => {
    setBody("<p>x</p>");
    const r = document.createRange();
    r.selectNodeContents(document.querySelector("p")!);
    expect(clampRangeToCell(r, null, null, document)).toBeNull();
  });
});

describe("captureSelection", () => {
  test("returns quote with 32-char context windows", () => {
    setBody(
      "<div id='prose'><p>" +
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor." +
        "</p></div>",
    );
    const prose = document.getElementById("prose")!;
    const text = prose.querySelector("p")!.firstChild!;
    const r = document.createRange();
    // select "consectetur"
    const full = text.nodeValue!;
    const start = full.indexOf("consectetur");
    r.setStart(text, start);
    r.setEnd(text, start + "consectetur".length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);

    const captured = captureSelection(prose, sel as unknown as Selection, "consectetur");
    expect(captured).not.toBeNull();
    expect(captured!.quote).toBe("consectetur");
    expect(captured!.context_before.endsWith("amet, ")).toBe(true);
    expect(captured!.context_after.startsWith(" adipiscing")).toBe(true);
  });

  test("recovers when selection start has whitespace that the caller trimmed off", () => {
    setBody(
      "<div id='prose'><p>" +
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit." +
        "</p></div>",
    );
    const prose = document.getElementById("prose")!;
    const text = prose.querySelector("p")!.firstChild!;
    const r = document.createRange();
    const full = text.nodeValue!;
    // Simulate a selection that includes the leading space before "consectetur"
    // — caller will .trim() the text but range.startOffset still points at the space.
    const wsStart = full.indexOf(" consectetur");
    r.setStart(text, wsStart);
    r.setEnd(text, wsStart + " consectetur".length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);

    const captured = captureSelection(prose, sel as unknown as Selection, "consectetur");
    expect(captured).not.toBeNull();
    expect(captured!.quote).toBe("consectetur");
    expect(captured!.context_before.endsWith("amet, ")).toBe(true);
  });

  test("recovers when selection includes trailing whitespace the caller trimmed off", () => {
    setBody(
      "<div id='prose'><p>" +
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit." +
        "</p></div>",
    );
    const prose = document.getElementById("prose")!;
    const text = prose.querySelector("p")!.firstChild!;
    const r = document.createRange();
    const full = text.nodeValue!;
    const start = full.indexOf("consectetur");
    // Selection extends past the word into the trailing space — caller .trim()s it off.
    r.setStart(text, start);
    r.setEnd(text, start + "consectetur ".length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);

    const captured = captureSelection(prose, sel as unknown as Selection, "consectetur");
    expect(captured).not.toBeNull();
    expect(captured!.quote).toBe("consectetur");
    expect(captured!.context_after.startsWith(" adipiscing")).toBe(true);
  });

  test("recovers when selection crosses a block boundary (sel.toString inserts \\n\\n, flat does not)", () => {
    setBody(
      "<div id='prose'>" +
        "<p>First paragraph ends here.</p>" +
        "<p>Second paragraph starts here.</p>" +
        "</div>",
    );
    const prose = document.getElementById("prose")!;
    const ps = prose.querySelectorAll("p");
    const r = document.createRange();
    const first = ps[0].firstChild!;
    const second = ps[1].firstChild!;
    r.setStart(first, first.nodeValue!.indexOf("ends here."));
    r.setEnd(second, "Second paragraph".length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);

    // The caller passes the trimmed sel.toString(), which in real browsers contains
    // "ends here.\n\nSecond paragraph". Our captureSelection should still locate it
    // by falling back to a window search around quoteStart, since flat is just the
    // concatenated text "ends here.Second paragraph".
    const captured = captureSelection(
      prose,
      sel as unknown as Selection,
      "ends here.Second paragraph",
    );
    expect(captured).not.toBeNull();
    expect(captured!.quote).toBe("ends here.Second paragraph");
  });

  test("returns null when selected text doesn't appear anywhere near quoteStart", () => {
    setBody(
      "<div id='prose'><p>" +
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua." +
        "</p></div>",
    );
    const prose = document.getElementById("prose")!;
    const text = prose.querySelector("p")!.firstChild!;
    const r = document.createRange();
    r.setStart(text, 0);
    r.setEnd(text, 5);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);

    // The text exists in the doc but far past the ±64 search window from quoteStart=0.
    const captured = captureSelection(prose, sel as unknown as Selection, "magna aliqua");
    expect(captured).toBeNull();
  });

  test("returns null when selected text doesn't appear in flat text (e.g. crossed image alt)", () => {
    setBody("<div id='prose'><p>before <img alt='diagram'> after</p></div>");
    const prose = document.getElementById("prose")!;
    const p = prose.querySelector("p")!;
    const r = document.createRange();
    r.setStart(p.firstChild!, 0);
    r.setEnd(p.lastChild!, 5);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    // simulate sel.toString() returning text with the alt embedded — won't match flat
    const got = captureSelection(prose, sel as unknown as Selection, "before diagram afte");
    expect(got).toBeNull();
  });
});

describe("highlightText", () => {
  test("wraps a contiguous quote in a single mark", () => {
    setBody("<div><p>The quick brown fox jumps.</p></div>");
    const root = document.querySelector("div")!;
    const marks = highlightText(root, "quick brown", "c1", false, "");
    expect(marks.length).toBe(1);
    const mark = root.querySelector("mark")!;
    expect(mark.textContent).toBe("quick brown");
    expect(mark.dataset.commentId).toBe("c1");
    expect(mark.classList.contains("rl-highlight")).toBe(true);
    expect(mark.classList.contains("resolved")).toBe(false);
  });
  test("wraps a quote that crosses inline elements with multiple marks", () => {
    setBody("<div><p>The <em>quick</em> brown fox.</p></div>");
    const root = document.querySelector("div")!;
    const marks = highlightText(root, "quick brown", "c1", false, "");
    expect(marks.length).toBe(2);
    expect(marks.map((m) => m.textContent).join("")).toBe("quick brown");
  });
  test("disambiguates with contextBefore when text appears twice", () => {
    setBody("<div><p>foo bar foo bar foo</p></div>");
    const root = document.querySelector("div")!;
    const marks = highlightText(root, "foo", "c1", false, "bar ");
    expect(marks.length).toBe(1);
    // first "foo" should be untouched, the marked "foo" follows "bar "
    const mark = marks[0]!;
    // The marked "foo" is the second occurrence (preceded by "bar "), so the
    // text node immediately before the mark ends in "bar " (containing the
    // full "foo bar " prefix that used to live in the original text node).
    expect(mark.previousSibling?.textContent?.endsWith("bar ")).toBe(true);
  });
  test("applies resolved class for resolved comments", () => {
    setBody("<div><p>hello world</p></div>");
    const root = document.querySelector("div")!;
    const [mark] = highlightText(root, "hello", "c1", true, "");
    expect(mark!.classList.contains("resolved")).toBe(true);
  });
  test("image quote wraps the matching <img> by alt", () => {
    setBody("<div><p>before <img alt='hero'> middle <img alt='other'></p></div>");
    const root = document.querySelector("div")!;
    const marks = highlightText(root, "[image: hero]", "c1", false, "");
    expect(marks.length).toBe(1);
    const mark = marks[0]!;
    expect(mark.classList.contains("rl-img")).toBe(true);
    expect(mark.querySelector("img")?.getAttribute("alt")).toBe("hero");
  });
  test("returns no marks when quote isn't found", () => {
    setBody("<div><p>hello</p></div>");
    const root = document.querySelector("div")!;
    expect(highlightText(root, "nonsense", "c1", false, "")).toEqual([]);
  });
});

describe("computeNavState", () => {
  function open(n: number): ClientComment[] {
    return Array.from({ length: n }, (_, i) => ({
      id: "c" + (i + 1),
      quote: "x",
      resolved: false,
      thread: [],
    }));
  }
  test("hidden when no open comments", () => {
    const s = computeNavState([], null, 0);
    expect(s.visible).toBe(false);
  });
  test("solo: shows 1/1 with prev hidden, next labelled 'Jump to comment'", () => {
    const s = computeNavState(open(1), null, 0);
    expect(s.visible).toBe(true);
    expect(s.countText).toBe("1 / 1");
    expect(s.showPrev).toBe(false);
    expect(s.nextLabel).toBe("Jump to comment ↓");
    expect(s.nextDisabled).toBe(false);
  });
  test("multi: prevDisabled at idx 0, nextDisabled at last", () => {
    const cs = open(3);
    expect(computeNavState(cs, null, 0).prevDisabled).toBe(true);
    expect(computeNavState(cs, null, 0).nextDisabled).toBe(false);
    expect(computeNavState(cs, null, 2).prevDisabled).toBe(false);
    expect(computeNavState(cs, null, 2).nextDisabled).toBe(true);
  });
  test("syncs navIdx to active card when one is set", () => {
    const cs = open(3);
    const s = computeNavState(cs, "c2", 0);
    expect(s.navIdx).toBe(1);
    expect(s.countText).toBe("2 / 3");
  });
  test("clamps stale navIdx when comments shrink", () => {
    const cs = open(2);
    const s = computeNavState(cs, null, 5);
    expect(s.navIdx).toBe(1);
  });
  test("ignores resolved comments in count", () => {
    const cs = open(3);
    cs[1]!.resolved = true;
    const s = computeNavState(cs, null, 0);
    expect(s.countText).toBe("1 / 2");
  });
});

describe("preserveScroll", () => {
  test("blurs active focused element before mutation", () => {
    setBody("<div id='prose'><textarea id='ta'></textarea></div>");
    const ta = document.getElementById("ta") as HTMLTextAreaElement;
    ta.focus();
    expect(document.activeElement).toBe(ta);
    let blurred = false;
    ta.addEventListener("blur", () => {
      blurred = true;
    });
    preserveScroll(
      () => {
        // mutation
        ta.remove();
      },
      { win: window as any, doc: document },
    );
    expect(blurred).toBe(true);
  });

  test("does NOT blur when active element matches protectFocusSelector", () => {
    setBody("<div id='new-comment-form'><textarea id='ta'></textarea></div>");
    const ta = document.getElementById("ta") as HTMLTextAreaElement;
    ta.focus();
    let blurred = false;
    ta.addEventListener("blur", () => {
      blurred = true;
    });
    preserveScroll(
      () => {
        // some sibling mutation, draft form preserved
        document.body.appendChild(document.createElement("div"));
      },
      {
        win: window as any,
        doc: document,
        protectFocusSelector: "#new-comment-form",
      },
    );
    expect(blurred).toBe(false);
  });

  test("skip:true bypasses both blur and scroll restore", () => {
    setBody("<textarea id='ta'></textarea>");
    const ta = document.getElementById("ta") as HTMLTextAreaElement;
    ta.focus();
    let blurred = false;
    ta.addEventListener("blur", () => {
      blurred = true;
    });
    let ran = false;
    preserveScroll(
      () => {
        ran = true;
      },
      { win: window as any, doc: document, skip: true },
    );
    expect(ran).toBe(true);
    expect(blurred).toBe(false);
  });
});
