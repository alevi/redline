import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  applyDiffSwap,
  diffStateKey,
  revertDiffSwap,
  updateToggleButton,
} from "./diffToggle";

beforeAll(() => GlobalRegistrator.register());
afterAll(async () => { await GlobalRegistrator.unregister(); });

beforeEach(() => { document.body.innerHTML = ""; });

describe("diffStateKey", () => {
  test("namespaces by context title so two files don't collide", () => {
    expect(diffStateKey("spec.md")).toBe("rl-diff-on-spec.md");
    expect(diffStateKey("notes.md")).toBe("rl-diff-on-notes.md");
    expect(diffStateKey("spec.md")).not.toBe(diffStateKey("notes.md"));
  });
});

describe("updateToggleButton", () => {
  function makeBtn(): HTMLButtonElement {
    const b = document.createElement("button");
    b.id = "btn-toggle-diff";
    b.textContent = "Show changes";
    b.setAttribute("aria-pressed", "false");
    document.body.appendChild(b);
    return b;
  }

  test("on=true flips text, aria-pressed, and adds .active", () => {
    const btn = makeBtn();
    updateToggleButton(btn, true);
    expect(btn.textContent).toBe("Hide changes");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.classList.contains("active")).toBe(true);
  });

  test("on=false flips back", () => {
    const btn = makeBtn();
    updateToggleButton(btn, true);
    updateToggleButton(btn, false);
    expect(btn.textContent).toBe("Show changes");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.classList.contains("active")).toBe(false);
  });
});

describe("applyDiffSwap / revertDiffSwap", () => {
  function makeProse(html: string): HTMLElement {
    const p = document.createElement("article");
    p.id = "prose";
    p.innerHTML = html;
    document.body.appendChild(p);
    return p;
  }

  test("apply swaps innerHTML and returns the previous content", () => {
    const prose = makeProse("<p>clean</p>");
    const prev = applyDiffSwap(prose, '<div class="diff-prose">DIFF</div>');
    expect(prev).toBe("<p>clean</p>");
    expect(prose.innerHTML).toContain("DIFF");
    expect(prose.dataset.diffMode).toBe("on");
  });

  test("apply is a no-op when already in diff mode (returns null, doesn't clobber the saved original)", () => {
    const prose = makeProse("<p>clean</p>");
    applyDiffSwap(prose, "<p>DIFF v1</p>");
    const prev = applyDiffSwap(prose, "<p>DIFF v2</p>");
    expect(prev).toBeNull();
    // Second call did not overwrite the prose (the caller already has the saved original).
    // We don't care which diff html is in there for this guarantee — only that we
    // didn't accidentally treat "DIFF v1" as the "original" to save.
  });

  test("revert restores the supplied original and clears diff mode", () => {
    const prose = makeProse("<p>clean</p>");
    const prev = applyDiffSwap(prose, "<p>DIFF</p>")!;
    const ok = revertDiffSwap(prose, prev);
    expect(ok).toBe(true);
    expect(prose.innerHTML).toBe("<p>clean</p>");
    expect(prose.dataset.diffMode).toBe("off");
  });

  test("revert is a no-op when not in diff mode", () => {
    const prose = makeProse("<p>clean</p>");
    const ok = revertDiffSwap(prose, "<p>stale</p>");
    expect(ok).toBe(false);
    expect(prose.innerHTML).toBe("<p>clean</p>");
  });

  test("apply → revert → apply cycle is stable", () => {
    const prose = makeProse("<p>clean</p>");
    const prev1 = applyDiffSwap(prose, "<p>DIFF</p>")!;
    revertDiffSwap(prose, prev1);
    const prev2 = applyDiffSwap(prose, "<p>DIFF</p>");
    expect(prev2).toBe("<p>clean</p>");
    expect(prose.dataset.diffMode).toBe("on");
  });
});
