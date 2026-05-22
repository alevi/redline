import { apiFetch } from "./state";
import {
  applyDiffSwap,
  diffStateKey,
  revertDiffSwap,
  updateToggleButton,
} from "./diffToggle";
import { applyHighlights, renderComments, triggerRoundAction } from "./render";

let originalProseHtml: string | null = null;
let diffHtmlCache: string | null = null;

async function fetchDiffHtml(): Promise<string | null> {
  if (diffHtmlCache !== null) return diffHtmlCache;
  const res = await fetch("/api/diff");
  const data = await res.json();
  if (!data.ok) return null;
  diffHtmlCache = data.html as string;
  return diffHtmlCache;
}

function syncToggleButton(on: boolean): void {
  const btn = document.getElementById(
    "btn-toggle-diff",
  ) as HTMLButtonElement | null;
  if (btn) updateToggleButton(btn, on);
}

export async function enableDiffMode(): Promise<void> {
  const prose = document.getElementById("prose");
  if (!prose) return;
  const html = await fetchDiffHtml();
  if (html == null) return;
  const previous = applyDiffSwap(prose, html);
  if (previous != null) originalProseHtml = previous;
  syncToggleButton(true);
  try {
    sessionStorage.setItem(diffStateKey(window.__REDLINE__.contextTitle), "1");
  } catch {}
  applyHighlights();
  renderComments();
}

export function disableDiffMode(): void {
  const prose = document.getElementById("prose");
  if (!prose || originalProseHtml == null) return;
  if (!revertDiffSwap(prose, originalProseHtml)) return;
  syncToggleButton(false);
  try {
    sessionStorage.removeItem(diffStateKey(window.__REDLINE__.contextTitle));
  } catch {}
  applyHighlights();
  renderComments();
}

async function toggleDiff(): Promise<void> {
  const prose = document.getElementById("prose");
  if (!prose) return;
  if (prose.dataset.diffMode === "on") disableDiffMode();
  else await enableDiffMode();
}

async function showDiffOverlay(): Promise<void> {
  const html = await fetchDiffHtml();
  if (html == null) return;
  document.getElementById("diff-panel-body")!.innerHTML = html;
  document.getElementById("diff-overlay")!.classList.add("open");
}

export function initDiffHandlers(): void {
  document.getElementById("btn-toggle-diff")?.addEventListener("click", () => {
    void toggleDiff();
  });
  document
    .getElementById("btn-compare")
    ?.addEventListener("click", () => showDiffOverlay());

  document
    .getElementById("diff-btn-accept")!
    .addEventListener("click", async () => {
      document.getElementById("diff-overlay")!.classList.remove("open");
      await apiFetch("/api/finish", { method: "POST" });
      const btnAccept = document.getElementById(
        "btn-accept",
      ) as HTMLButtonElement | null;
      if (btnAccept) {
        btnAccept.disabled = true;
        btnAccept.textContent = "✓ Done";
      }
      const banner = document.getElementById("sidebar-status-banner");
      if (banner) {
        banner.classList.remove("revising");
        banner.textContent = "Review complete. Document is ready.";
        banner.style.display = "block";
      }
    });

  document
    .getElementById("diff-btn-feedback")!
    .addEventListener("click", () => {
      document.getElementById("diff-overlay")!.classList.remove("open");
    });

  document.getElementById("diff-btn-close")?.addEventListener("click", () => {
    document.getElementById("diff-overlay")!.classList.remove("open");
  });

  // Round picker
  const roundBadge = document.getElementById("round-badge");
  const roundPicker = document.getElementById("round-picker");
  if (roundBadge && roundPicker) {
    roundBadge.addEventListener("click", (e) => {
      e.stopPropagation();
      roundPicker.style.display =
        roundPicker.style.display === "none" ? "block" : "none";
    });
    document.addEventListener("click", () => {
      roundPicker.style.display = "none";
    });
  }

  // Context banner
  function dismissContextBanner(): void {
    const banner = document.getElementById("context-banner");
    if (banner) banner.remove();
    try {
      localStorage.setItem(
        "rl-ctx-dismissed-" + window.__REDLINE__.contextTitle,
        "1",
      );
    } catch {}
  }
  // Expose globally for the inline onclick in the HTML template
  window.dismissContextBanner = dismissContextBanner;

  (function () {
    const banner = document.getElementById("context-banner");
    if (!banner) return;
    try {
      if (
        localStorage.getItem(
          "rl-ctx-dismissed-" + window.__REDLINE__.contextTitle,
        )
      )
        banner.remove();
    } catch {}
  })();

  // Accept button
  document.getElementById("btn-accept")?.addEventListener("click", () => {
    const btnAccept = document.getElementById(
      "btn-accept",
    ) as HTMLButtonElement | null;
    if (btnAccept?.disabled) return;
    triggerRoundAction(btnAccept!.dataset.mode!);
  });
}
