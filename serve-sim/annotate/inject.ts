// The script the proxy adds to serve-sim's preview page. It runs inside the
// page, so it can reach serve-sim's DOM: it adds an Annotate button to the
// toolbar under the device, and tells the BB panel (the parent window)
// where the device's screen is drawn. The panel draws Annotate over exactly
// that rectangle. It relies on serve-sim's toolbar labels and finds nothing
// to change when a serve-sim update renames them.

export const INJECT_PATH = "/__bb-annotate/inject.js";

/** Messages from the page carry this source; messages to it carry PARENT. */
export const PAGE_SOURCE = "serve-sim-annotate";
export const PARENT_SOURCE = "bb-serve-sim";

export const injectScript = `(() => {
  if (window.__bbAnnotate) return;
  window.__bbAnnotate = true;
  const PAGE = ${JSON.stringify(PAGE_SOURCE)};
  const PARENT = ${JSON.stringify(PARENT_SOURCE)};
  const send = (message) => parent.postMessage({ source: PAGE, ...message }, "*");
  let active = false;
  let last = "";

  const ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5a2 2 0 0 1-2 2H8.5L4 20V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/><path d="M8.5 8.5h7M8.5 12h4.5"/></svg>';

  function paint(button) {
    button.setAttribute("aria-pressed", String(active));
    button.style.background = active
      ? "color-mix(in srgb, var(--serve-sim-ink, #fff) 16%, transparent)"
      : "transparent";
  }

  // A pill like serve-sim's accessibility-overlay pill, with one button.
  function ensureButton() {
    const existing = document.querySelector("[data-bb-annotate-button]");
    if (existing) return paint(existing);
    const actions = document.querySelector('[data-simulator-toolbar][aria-label="Simulator actions"]');
    const row = actions && actions.parentElement;
    if (!row) return;
    const pillModel = row.querySelector('[data-simulator-toolbar][aria-label="Accessibility overlay"]') || actions;
    const buttonModel = pillModel.querySelector("button");
    if (!buttonModel) return;
    const pill = pillModel.cloneNode(false);
    pill.setAttribute("aria-label", "Annotate");
    const button = buttonModel.cloneNode(false);
    button.removeAttribute("aria-describedby");
    button.setAttribute("aria-label", "Annotate an element for the agent");
    button.title = "Annotate an element for the agent (⌥⌘A)";
    button.setAttribute("data-bb-annotate-button", "");
    button.innerHTML = ICON;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      send({ type: "toggle" });
    });
    paint(button);
    pill.appendChild(button);
    row.appendChild(pill);
  }

  // The live screen: the largest stream canvas, video, or MJPEG image.
  function screen() {
    let best = null;
    let area = 0;
    for (const el of document.querySelectorAll('canvas, video, img[src*="stream.mjpeg"]')) {
      const box = el.getBoundingClientRect();
      if (box.width < 80 || box.height < 80) continue;
      if (box.width * box.height > area) {
        best = el;
        area = box.width * box.height;
      }
    }
    return best;
  }

  function report() {
    ensureButton();
    const el = screen();
    const box = el && el.getBoundingClientRect();
    const rect = box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    const preview = window.__SIM_PREVIEW__ || {};
    const key = JSON.stringify([rect, preview.device]);
    if (key === last) return;
    last = key;
    send({ type: "screen", rect, udid: typeof preview.device === "string" ? preview.device : null });
  }

  addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== PARENT) return;
    if (data.type === "state") {
      active = !!data.active;
      const button = document.querySelector("[data-bb-annotate-button]");
      if (button) paint(button);
    } else if (data.type === "hello") {
      last = "";
      report();
    }
  });
  // Escape in the page, where the panel's own key handler cannot hear it.
  addEventListener("keydown", (event) => {
    if (active && event.key === "Escape") send({ type: "exit" });
    if (event.code === "KeyA" && event.altKey && event.metaKey) {
      event.preventDefault();
      send({ type: "toggle" });
    }
  }, true);
  addEventListener("resize", report);
  setInterval(report, 250);
  report();
})();`;
