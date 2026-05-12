import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => {
  GlobalRegistrator.register();
  (window as any).__REDLINE__ = {
    comments: [],
    roundResolved: false,
    totalRounds: 1,
    contextTitle: "",
    csrfToken: "test-token",
  };
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.innerHTML = "";
});

async function loadCards() {
  return await import("./cards");
}

describe("reply form submit", () => {
  test("clears the textarea before invoking submitReply (click)", async () => {
    const { buildCommentCard, setCardCallbacks } = await loadCards();
    const captured: { id: string; message: string }[] = [];
    let textareaValueAtCallback: string | null = null;
    const replyForm = { current: null as HTMLDivElement | null };

    setCardCallbacks({
      focusComment: () => {},
      updateNav: () => {},
      positionCards: () => {},
      resolveComment: () => {},
      reopenComment: () => {},
      toggleReplyForm: () => {},
      submitReply: (id, message) => {
        captured.push({ id, message });
        const ta = replyForm.current!.querySelector(".reply-input") as HTMLTextAreaElement;
        textareaValueAtCallback = ta.value;
      },
    });

    const card = buildCommentCard({
      id: "c1",
      quote: "hi",
      resolved: false,
      thread: [],
    });
    document.body.appendChild(card);
    replyForm.current = card.querySelector(".reply-form") as HTMLDivElement;
    const ta = replyForm.current.querySelector(".reply-input") as HTMLTextAreaElement;
    ta.value = "  my reply  ";

    (replyForm.current.querySelector(".reply-submit") as HTMLButtonElement).click();

    expect(captured).toEqual([{ id: "c1", message: "my reply" }]);
    expect(textareaValueAtCallback).toBe("");
    expect(ta.value).toBe("");
  });

  test("clears the textarea on cmd+enter", async () => {
    const { buildCommentCard, setCardCallbacks } = await loadCards();
    const captured: { id: string; message: string }[] = [];

    setCardCallbacks({
      focusComment: () => {},
      updateNav: () => {},
      positionCards: () => {},
      resolveComment: () => {},
      reopenComment: () => {},
      toggleReplyForm: () => {},
      submitReply: (id, message) => captured.push({ id, message }),
    });

    const card = buildCommentCard({
      id: "c2",
      quote: "hi",
      resolved: false,
      thread: [],
    });
    document.body.appendChild(card);
    const form = card.querySelector(".reply-form") as HTMLDivElement;
    const ta = form.querySelector(".reply-input") as HTMLTextAreaElement;
    ta.value = "via shortcut";

    const evt = new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true });
    ta.dispatchEvent(evt);

    expect(captured).toEqual([{ id: "c2", message: "via shortcut" }]);
    expect(ta.value).toBe("");
  });

  test("does not call submitReply or clear when message is empty/whitespace", async () => {
    const { buildCommentCard, setCardCallbacks } = await loadCards();
    const captured: { id: string; message: string }[] = [];

    setCardCallbacks({
      focusComment: () => {},
      updateNav: () => {},
      positionCards: () => {},
      resolveComment: () => {},
      reopenComment: () => {},
      toggleReplyForm: () => {},
      submitReply: (id, message) => captured.push({ id, message }),
    });

    const card = buildCommentCard({
      id: "c3",
      quote: "hi",
      resolved: false,
      thread: [],
    });
    document.body.appendChild(card);
    const form = card.querySelector(".reply-form") as HTMLDivElement;
    const ta = form.querySelector(".reply-input") as HTMLTextAreaElement;
    ta.value = "   ";

    (form.querySelector(".reply-submit") as HTMLButtonElement).click();

    expect(captured).toEqual([]);
    expect(ta.value).toBe("   ");
  });
});

describe("thread message markdown", () => {
  test("renders messageHtml when present instead of escaping the raw message", async () => {
    const { buildCommentCard, setCardCallbacks } = await loadCards();
    setCardCallbacks({
      focusComment: () => {},
      updateNav: () => {},
      positionCards: () => {},
      resolveComment: () => {},
      reopenComment: () => {},
      toggleReplyForm: () => {},
      submitReply: () => {},
    });

    const card = buildCommentCard({
      id: "c-md",
      quote: "hi",
      resolved: false,
      thread: [
        {
          role: "agent",
          name: "Claude",
          message: "Here are **two** options:\n1. first\n2. second",
          messageHtml: "<p>Here are <strong>two</strong> options:</p><ol><li>first</li><li>second</li></ol>",
        },
      ],
    });
    document.body.appendChild(card);

    const msg = card.querySelector(".thread-message") as HTMLDivElement;
    expect(msg.querySelector("strong")?.textContent).toBe("two");
    expect(msg.querySelectorAll("ol li").length).toBe(2);
    expect(msg.textContent).not.toContain("**");
  });

  test("falls back to escaped text when messageHtml is absent", async () => {
    const { buildCommentCard, setCardCallbacks } = await loadCards();
    setCardCallbacks({
      focusComment: () => {},
      updateNav: () => {},
      positionCards: () => {},
      resolveComment: () => {},
      reopenComment: () => {},
      toggleReplyForm: () => {},
      submitReply: () => {},
    });

    const card = buildCommentCard({
      id: "c-plain",
      quote: "hi",
      resolved: false,
      thread: [
        { role: "human", message: "raw <script>alert(1)</script> text" },
      ],
    });
    document.body.appendChild(card);

    const msg = card.querySelector(".thread-message") as HTMLDivElement;
    expect(msg.querySelector("script")).toBeNull();
    expect(msg.textContent).toContain("<script>");
  });
});
