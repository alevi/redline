import { apiFetch } from "./state";
import { state } from "./state";
import {
  applyRoundState,
  triggerRoundAction,
} from "./render";

export function showRevisionBanner(): void {
  if (document.getElementById("revision-banner")) return;
  const banner = document.createElement("div");
  banner.id = "revision-banner";
  banner.className = "revision-banner";
  banner.innerHTML =
    '<span class="revision-banner-text">Document revised.</span>' +
    '<button class="revision-banner-link" id="revision-banner-diff">See what changed \u2192</button>' +
    '<button class="revision-banner-dismiss" aria-label="Dismiss">\u2715</button>';
  banner.querySelector("#revision-banner-diff")!.addEventListener("click", () => {
    banner.remove();
    showDiffOverlay();
  });
  banner.querySelector(".revision-banner-dismiss")!.addEventListener("click", () => banner.remove());
  const prose = document.getElementById("prose")!;
  prose.parentNode!.insertBefore(banner, prose);
}

async function showDiffOverlay(): Promise<void> {
  const res = await fetch("/api/diff");
  const data = await res.json();
  if (!data.ok) return;
  document.getElementById("diff-panel-body")!.innerHTML = data.html;
  document.getElementById("diff-overlay")!.classList.add("open");
}

export function initDiffHandlers(): void {
  document.getElementById("btn-compare")?.addEventListener("click", () => showDiffOverlay());

  document.getElementById("diff-btn-accept")!.addEventListener("click", async () => {
    document.getElementById("diff-overlay")!.classList.remove("open");
    await apiFetch("/api/finish", { method: "POST" });
    const btnAccept = document.getElementById("btn-accept") as HTMLButtonElement | null;
    if (btnAccept) {
      btnAccept.disabled = true;
      btnAccept.textContent = "\u2713 Done";
    }
    const banner = document.getElementById("sidebar-status-banner");
    if (banner) {
      banner.classList.remove("revising");
      banner.textContent = "Review complete. Document is ready.";
      banner.style.display = "block";
    }
  });

  document.getElementById("diff-btn-feedback")!.addEventListener("click", () => {
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
      roundPicker.style.display = roundPicker.style.display === "none" ? "block" : "none";
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
      localStorage.setItem("rl-ctx-dismissed-" + window.__REDLINE__.contextTitle, "1");
    } catch {}
  }
  // Expose globally for the inline onclick in the HTML template
  window.dismissContextBanner = dismissContextBanner;

  (function () {
    const banner = document.getElementById("context-banner");
    if (!banner) return;
    try {
      if (localStorage.getItem("rl-ctx-dismissed-" + window.__REDLINE__.contextTitle))
        banner.remove();
    } catch {}
  })();

  // Accept button
  document.getElementById("btn-accept")?.addEventListener("click", () => {
    const btnAccept = document.getElementById("btn-accept") as HTMLButtonElement | null;
    if (btnAccept?.disabled) return;
    triggerRoundAction(btnAccept!.dataset.mode!);
  });
}
