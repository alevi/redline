// First-run security banner toggle.
//
// The banner DOM is rendered hidden by server-page.ts on every non-readonly
// page load; this module decides whether to reveal it based on a localStorage
// ack key. Dismissal persists per-machine, not per-doc, so the warning
// doesn't follow the user across every project they review.
//
// Takes `document` and `window` injected so happy-dom tests can exercise
// the full flow without touching globals at module-load time.

const ACK_KEY = "redline-security-ack";

export function initFirstRunBanner(doc: Document, win: Window): void {
  const banner = doc.getElementById("first-run-banner");
  if (!banner) return;

  let ack: string | null = null;
  try { ack = win.localStorage.getItem(ACK_KEY); } catch { /* private browsing */ }
  if (ack) return;

  banner.removeAttribute("hidden");
  doc.getElementById("first-run-dismiss")?.addEventListener("click", () => {
    try { win.localStorage.setItem(ACK_KEY, new Date().toISOString()); } catch { /* private browsing */ }
    banner.setAttribute("hidden", "");
  });
}
