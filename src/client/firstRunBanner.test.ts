import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { initFirstRunBanner } from "./firstRunBanner";

beforeAll(() => GlobalRegistrator.register());
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.innerHTML = "";
  try {
    localStorage.clear();
  } catch {}
});

function makeBanner(): HTMLElement {
  document.body.innerHTML = `
    <div class="first-run-banner" id="first-run-banner" hidden>
      <span>Redline sends document and comment text to your selected local agent. Use trusted docs.</span>
      <button class="first-run-dismiss" id="first-run-dismiss">Got it</button>
    </div>
  `;
  return document.getElementById("first-run-banner")!;
}

describe("initFirstRunBanner", () => {
  test("reveals the banner when no ack is stored", () => {
    const banner = makeBanner();
    expect(banner.hasAttribute("hidden")).toBe(true);
    initFirstRunBanner(document, window);
    expect(banner.hasAttribute("hidden")).toBe(false);
  });

  test("leaves the banner hidden when an ack is already stored", () => {
    const banner = makeBanner();
    localStorage.setItem("redline-security-ack", "2026-05-09T00:00:00Z");
    initFirstRunBanner(document, window);
    expect(banner.hasAttribute("hidden")).toBe(true);
  });

  test("dismiss click sets the ack key and hides the banner", () => {
    const banner = makeBanner();
    initFirstRunBanner(document, window);
    expect(banner.hasAttribute("hidden")).toBe(false);

    const dismiss = document.getElementById(
      "first-run-dismiss",
    ) as HTMLButtonElement;
    dismiss.click();

    expect(banner.hasAttribute("hidden")).toBe(true);
    const stored = localStorage.getItem("redline-security-ack");
    expect(stored).toBeTruthy();
    // The stored value is an ISO timestamp; sanity-check the shape.
    expect(stored).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("a second initFirstRunBanner call after dismissal is a no-op", () => {
    makeBanner();
    initFirstRunBanner(document, window);
    (document.getElementById("first-run-dismiss") as HTMLButtonElement).click();

    // Re-render the banner DOM (simulates a fresh page load) and re-init.
    const banner2 = makeBanner();
    initFirstRunBanner(document, window);
    expect(banner2.hasAttribute("hidden")).toBe(true);
  });

  test("missing banner element is a silent no-op (does not throw)", () => {
    document.body.innerHTML = ""; // no banner in DOM
    expect(() => initFirstRunBanner(document, window)).not.toThrow();
  });
});
