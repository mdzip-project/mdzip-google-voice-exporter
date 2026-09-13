// ==UserScript==
// @name         Google Voice Chat Exporter
// @namespace    https://github.com/mdzip-project/mdzip-google-voice-exporter
// @version      0.2.1
// @description  Save an open Google Voice conversation — text, timestamps, and photos — as a single portable file.
// @match        https://voice.google.com/*
// @license      Apache-2.0
// @require      https://cdn.jsdelivr.net/npm/@mdzip/core-js@1.4.0/dist/mdzip-core.iife.min.js
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// @downloadURL  https://raw.githubusercontent.com/mdzip-project/mdzip-google-voice-exporter/main/google-voice-chat-exporter.user.js
// @updateURL    https://raw.githubusercontent.com/mdzip-project/mdzip-google-voice-exporter/main/google-voice-chat-exporter.user.js
// ==/UserScript==

(function () {
  "use strict";

  const APP_NAME = "Google Voice Chat Exporter";
  const APP_VERSION = "0.2.1";
  const APP_URL = "https://github.com/mdzip-project/mdzip-google-voice-exporter";
  // The exported file is a standard zip either way (manifest.json and all) —
  // this only controls the extension. Set to "zip" if you'd rather skip the
  // "what do I open .mdz with" step and go straight to a normal zip file.
  const EXPORT_FILE_EXTENSION = "mdz";
  const BUTTON_ID = "gv-mdz-export-button";
  const STYLE_ID = "gv-mdz-export-style";
  // A safety valve, not a real limit — normal exports stop via the
  // TOP_STABLE_CHECKS condition once scrolling actually reaches the top.
  // This only guards against a broken/never-settling scroll container.
  const MAX_SCROLL_STEPS = 2000;
  const SCROLL_PAUSE_MS = 900;
  const ASSET_FETCH_TIMEOUT_MS = 15000;
  const TOP_STABLE_CHECKS = 16;
  let activeButton = null;
  let exportCancelRequested = false;
  let multiYearNoticeShown = false;
  let forceSingleFileOverride = false;
  let scrollToTopActive = false;
  let scrollToTopCancelRequested = false;
  const STATUS_SUCCESS_HIDE_MS = 20000;
  const HIDE_TIP_STORAGE_KEY = "gvMdzExportTipHidden";
  const PROGRESS_STORAGE_KEY = "gvMdzExportProgress";
  const SCROLL_DIAGNOSTICS_KEY = "gvMdzScrollToTopDiagnostics";
  const SCROLL_NETWORK_LOG_KEY = "gvMdzScrollToTopNetworkLog";

  const FORMAT_HINT_HTML = [
    "Both are the exact same standard zip archive (manifest.json and all) - this only changes the file extension.<br/>",
    "The <strong>.mdz</strong> format can be viewed instantly without unzipping first.",
    "Current viewers include:",
    "<a href=\"https://mdzip.org/studio.html\" target=\"_blank\" rel=\"noopener noreferrer\">MDZip Studio (Window only for now)</a>,",
    "<a href=\"https://mdzip.org/studio.html\" target=\"_blank\" rel=\"noopener noreferrer\">Windows Explorer Preview</a> (included with Studio on Windows),",
    "<a href=\"https://marketplace.visualstudio.com/items?itemName=mdzip-project.mdzip-vscode\" target=\"_blank\" rel=\"noopener noreferrer\">MDZip VS Code extension</a>,",
    "and the <a href=\"https://mdzip.org/editor-demo.html\" target=\"_blank\" rel=\"noopener noreferrer\">mdzip.org demo page</a>.",
    "Other applications and extensions are in the works.<br/><br/>",
    "<strong>.zip</strong> skips that hint if you'd rather your OS treat it as an ordinary zip file from the start."
  ].join(" ");

  const README_MD = [
    "# Google Voice Conversation Export",
    "",
    "Open `index.md` to read the conversation — it is plain Markdown text, one heading per day. The `images/` folder holds the photos, linked from the text.",
    "",
    "This file is a ZIP archive. If your tools do not open it directly, rename it from `.mdz` to `.zip` and extract it.",
    "",
    "The `.mdz` extension marks it as an MDZip package: a ZIP with a predictable layout, so viewers can open it without extracting first. That is optional — the files above are the whole content. More: https://mdzip.org",
    ""
  ].join("\n");

  const AGENTS_MD = [
    "# AGENTS.md",
    "",
    "This MDZip archive contains a Google Voice conversation export.",
    "",
    "Agent guidance:",
    "",
    "- Treat `index.md` as the entry point.",
    "- Resolve image and attachment references relative to the archive root.",
    "- Preserve message order, sender labels, timestamps, and asset links when summarizing or transforming the content.",
    "- Do not infer missing messages; report visible export warnings when present.",
    "- Do not expose phone numbers, contact names, or message contents outside the user's requested task.",
    "",
    "MDZip documentation: https://mdzip.org",
    ""
  ].join("\n");

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // A setTimeout-based wait, but run inside a dedicated Worker instead of on
  // the main thread. Both Chrome (Intensive Throttling) and Firefox
  // (budget-based background throttling) slow down setTimeout on a
  // backgrounded/unfocused tab, sometimes to under once a minute — but that
  // throttling is applied to the window/document, not to workers, so timers
  // ticking inside a Worker keep firing at their real requested rate
  // regardless of tab focus. Falls back to the plain setTimeout wait if
  // Worker/Blob construction fails (e.g. a page CSP blocking blob: workers),
  // so scroll-to-top still works, just without the background-tab immunity.
  const unthrottledWait = (() => {
    let workerWait = null;
    try {
      const workerSource = `
        self.onmessage = function (event) {
          var id = event.data.id;
          var delay = event.data.delay;
          setTimeout(function () {
            self.postMessage({ id: id });
          }, delay);
        };
      `;
      const blob = new Blob([workerSource], { type: "application/javascript" });
      const worker = new Worker(URL.createObjectURL(blob));
      const pending = new Map();
      let nextId = 0;

      worker.onmessage = (event) => {
        const resolve = pending.get(event.data.id);
        if (!resolve) return;
        pending.delete(event.data.id);
        resolve();
      };

      worker.onerror = () => {
        // If the worker itself breaks mid-run, fail open rather than hang
        // every future wait forever.
        for (const resolve of pending.values()) resolve();
        pending.clear();
      };

      workerWait = (ms) => new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        worker.postMessage({ id, delay: ms });
      });
    } catch {
      workerWait = null;
    }

    if (!workerWait) return wait;

    // A page CSP blocking blob: workers can fail the load *asynchronously*
    // (no synchronous throw to catch above), leaving every worker message
    // posted into the void — that hangs every future wait forever with no
    // error. Racing against a plain setTimeout guarantees forward progress
    // either way: a healthy worker always resolves first (untouched by
    // throttling), while a broken one silently falls back to normal —
    // throttleable, but never stuck.
    return (ms) => Promise.race([workerWait(ms), wait(ms + 500)]);
  })();

  // Survives a tab crash: localStorage writes are synchronous and durable
  // immediately (unlike GM_setValue, which can be async/batched depending on
  // the userscript manager, and could lose the last write in a hard crash).
  // A crash skips exportCurrentConversation's finally block entirely, so
  // anything still saved here on next load means the last attempt never
  // finished cleanly.
  function saveProgressCheckpoint(data) {
    try {
      localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify({ ...data, savedAt: new Date().toISOString() }));
    } catch {
      // Storage can throw (quota, private mode); checkpointing is best-effort.
    }
  }

  function clearProgressCheckpoint() {
    localStorage.removeItem(PROGRESS_STORAGE_KEY);
  }

  function checkForCrashedExport() {
    const raw = localStorage.getItem(PROGRESS_STORAGE_KEY);
    if (!raw) return;

    let info;
    try {
      info = JSON.parse(raw);
    } catch {
      clearProgressCheckpoint();
      return;
    }

    console.warn(`[${APP_NAME}] Previous export did not finish cleanly — likely a tab crash.`, info);
    showStatus(
      `Heads up: a previous export ended unexpectedly (${info.phase || "unknown phase"}, ${info.messageCount ?? "?"} messages collected as of ${info.savedAt}). Check the console for details.`,
      STATUS_SUCCESS_HIDE_MS
    );
    clearProgressCheckpoint();
  }

  function install() {
    injectStyles();
    checkForCrashedExport();
    installButtonWhenReady();

    if (typeof GM_registerMenuCommand === "function") {
      GM_registerMenuCommand("Export current Google Voice conversation...", () => {
        openExportDialogOrCancel();
      });
      GM_registerMenuCommand("Scroll to top (load full conversation history) / click again to cancel", () => {
        scrollToTopOrCancel();
      });
    }

    const observer = new MutationObserver(() => installButtonWhenReady());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BUTTON_ID} {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: 50%;
        color: #0b57d0;
        cursor: pointer;
        display: inline-flex;
        height: 28px;
        width: 28px;
        justify-content: center;
        margin-inline-start: 6px;
        padding: 0;
        vertical-align: middle;
      }
      #${BUTTON_ID}:hover:not(:disabled) {
        background: rgba(11, 87, 208, 0.08);
      }
      #${BUTTON_ID}:disabled {
        cursor: progress;
        opacity: 0.55;
      }
      #${BUTTON_ID}.gv-mdz-busy {
        color: #c5221f;
      }
      #${BUTTON_ID}.gv-mdz-busy:hover {
        background: rgba(197, 34, 31, 0.08);
      }
      #${BUTTON_ID}:focus-visible {
        outline: 2px solid #a8c7fa;
        outline-offset: 2px;
      }
      #${BUTTON_ID} svg {
        display: block;
        pointer-events: none;
      }
      .gv-mdz-progress-panel {
        background: #1f1f1f;
        border-radius: 8px;
        bottom: 20px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
        color: #fff;
        font: 400 13px/18px Arial, sans-serif;
        max-width: min(360px, calc(100vw - 32px));
        overflow: hidden;
        position: fixed;
        right: 20px;
        width: 360px;
        z-index: 2147483647;
      }
      .gv-mdz-progress-header {
        align-items: center;
        background: rgba(255, 255, 255, 0.06);
        display: flex;
        justify-content: space-between;
        padding: 8px 10px 8px 14px;
      }
      .gv-mdz-progress-title {
        font-weight: 600;
        opacity: 0.85;
      }
      .gv-mdz-progress-close {
        background: transparent;
        border: 0;
        color: #fff;
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        opacity: 0.7;
        padding: 0 4px;
      }
      .gv-mdz-progress-close:hover {
        opacity: 1;
      }
      .gv-mdz-progress-current {
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        padding: 10px 14px;
        word-break: break-word;
      }
      .gv-mdz-progress-history {
        max-height: 160px;
        overflow-y: auto;
        padding: 6px 14px;
      }
      .gv-mdz-progress-history:empty {
        display: none;
      }
      .gv-mdz-progress-history-line {
        color: rgba(255, 255, 255, 0.6);
        font-size: 11px;
        padding: 2px 0;
        word-break: break-word;
      }
      .gv-mdz-tip {
        background: #eef3fc;
        border: 1px solid #0b57d0;
        border-left: 4px solid #0b57d0;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        box-sizing: border-box;
        color: #1f1f1f;
        font: 400 13px/18px "Google Sans Text", Arial, sans-serif;
        left: 50%;
        max-width: min(420px, calc(100vw - 32px));
        padding: 14px 16px;
        position: fixed;
        top: 72px;
        transform: translateX(-50%);
        z-index: 2147483647;
      }
      .gv-mdz-tip a {
        color: #0b57d0;
      }
      .gv-mdz-tip-close {
        background: transparent;
        border: 0;
        color: #5f6368;
        cursor: pointer;
        float: right;
        font-size: 16px;
        line-height: 1;
        padding: 0 0 0 12px;
      }
      .gv-mdz-tip-row {
        align-items: center;
        display: flex;
        gap: 6px;
        margin-top: 10px;
      }
      .gv-mdz-tip-row label {
        cursor: pointer;
      }
      .gv-mdz-tip-action {
        margin-top: 10px;
        padding: 6px 10px;
        border: 1px solid #0b57d0;
        border-radius: 6px;
        background: #fff;
        color: #0b57d0;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
      }
      .gv-mdz-tip-action:hover {
        background: #eef3fc;
      }
      .gv-mdz-dialog-overlay {
        align-items: center;
        background: rgba(32, 33, 36, 0.5);
        display: flex;
        inset: 0;
        justify-content: center;
        position: fixed;
        z-index: 2147483647;
      }
      .gv-mdz-dialog {
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
        box-sizing: border-box;
        color: #1f1f1f;
        font: 400 13px/1.5 "Google Sans Text", Arial, sans-serif;
        max-width: min(440px, calc(100vw - 32px));
        max-height: calc(100vh - 32px);
        overflow-y: auto;
        padding: 20px 22px;
        width: 440px;
      }
      .gv-mdz-dialog h2 {
        font-size: 16px;
        margin: 0 0 14px;
      }
      .gv-mdz-dialog-option {
        margin-bottom: 12px;
      }
      .gv-mdz-dialog-option-label {
        align-items: center;
        cursor: pointer;
        display: flex;
        gap: 8px;
      }
      .gv-mdz-dialog-sub {
        align-items: center;
        display: flex;
        gap: 8px;
        margin: 6px 0 0 24px;
      }
      .gv-mdz-dialog-sub input[type="number"],
      .gv-mdz-dialog-sub input[type="date"] {
        border: 1px solid #cfd6df;
        border-radius: 6px;
        font: inherit;
        padding: 5px 8px;
        width: 100px;
      }
      .gv-mdz-dialog-sub input:disabled {
        background: #f4f6f8;
        color: #9aa0a6;
      }
      .gv-mdz-dialog-divider {
        border: 0;
        border-top: 1px solid #e2e6ea;
        margin: 16px 0;
      }
      .gv-mdz-dialog-row {
        align-items: center;
        display: flex;
        gap: 10px;
        margin-bottom: 10px;
      }
      .gv-mdz-dialog-hint {
        background: #f4f6f8;
        border-radius: 6px;
        color: #3d434b;
        font-size: 12px;
        margin: 6px 0 0;
        padding: 8px 10px;
      }
      .gv-mdz-dialog-hint a {
        color: #0b57d0;
      }
      .gv-mdz-dialog label.gv-mdz-dialog-link {
        color: #0b57d0;
        cursor: pointer;
        font-size: 12px;
        text-decoration: underline;
      }
      .gv-mdz-dialog-filename {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-top: 4px;
      }
      .gv-mdz-dialog-filename input {
        border: 1px solid #cfd6df;
        border-radius: 6px;
        box-sizing: border-box;
        font: inherit;
        padding: 7px 9px;
        width: 100%;
      }
      .gv-mdz-dialog-actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 18px;
      }
      .gv-mdz-dialog-btn {
        border-radius: 6px;
        cursor: pointer;
        font: inherit;
        padding: 8px 16px;
      }
      .gv-mdz-dialog-btn-secondary {
        background: #fff;
        border: 1px solid #cfd6df;
        color: #1f1f1f;
      }
      .gv-mdz-dialog-btn-secondary:hover {
        background: #f4f6f8;
      }
      .gv-mdz-dialog-btn-primary {
        background: #0b57d0;
        border: 1px solid #0b57d0;
        color: #fff;
      }
      .gv-mdz-dialog-btn-primary:hover {
        background: #0a4bb8;
      }
    `;
    document.head.appendChild(style);
  }

  const DOWNLOAD_ICON_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 16l5-5h-3V4h-4v7H7z"/><path d="M5 18h14v2H5z"/></svg>`;
  const CANCEL_ICON_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M6 6h12v12H6z"/></svg>`;

  function installButtonWhenReady() {
    if (document.getElementById(BUTTON_ID)) return;

    const header = findConversationHeader();
    if (!header) return;

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.title = "Export this conversation to MDZip";
    button.setAttribute("aria-label", "Export this conversation to MDZip");
    // The title area this gets inserted into is marked aria-hidden (its
    // accessible name lives in a separate hidden heading), so this needs an
    // explicit override to remain reachable by assistive tech.
    button.setAttribute("aria-hidden", "false");
    button.innerHTML = DOWNLOAD_ICON_SVG;
    button.addEventListener("click", () => openExportDialogOrCancel());

    const titleContainer = findHeaderTitleContainer(header);
    if (titleContainer) {
      titleContainer.appendChild(button);
      return;
    }

    const actionArea = findHeaderActionArea(header);
    if (actionArea) {
      actionArea.prepend(button);
    } else {
      header.appendChild(button);
    }
  }

  function findHeaderTitleContainer(header) {
    const titleElement = header.querySelector("[class*='header-title']");
    return (
      header.querySelector("[class*='title-container']") ||
      (titleElement && titleElement.parentElement) ||
      null
    );
  }

  function findConversationHeader() {
    return (
      document.querySelector("gv-thread-details-header") ||
      document.querySelector("gv-thread-details header") ||
      document.querySelector("gv-thread-details [role='banner']")
    );
  }

  function findHeaderActionArea(header) {
    const buttons = Array.from(header.querySelectorAll("button"));
    if (buttons.length === 0) return null;
    return buttons[buttons.length - 1].parentElement;
  }

  function openExportDialogOrCancel() {
    if (activeButton) {
      requestExportCancel();
      return;
    }
    openExportDialog();
  }

  function openExportDialog() {
    document.querySelector(".gv-mdz-dialog-overlay")?.remove();

    const contactLabel = getPreviewContactLabel();
    const currentYear = new Date().getFullYear();

    const overlay = document.createElement("div");
    overlay.className = "gv-mdz-dialog-overlay";
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) overlay.remove();
    });

    const dialog = document.createElement("div");
    dialog.className = "gv-mdz-dialog";
    overlay.appendChild(dialog);

    const heading = document.createElement("h2");
    heading.textContent = "Export Conversation";
    dialog.appendChild(heading);

    // --- Scope options ---
    const scopeAll = buildScopeOption("all", "Export this entire conversation (could take a while)", true);
    const splitSub = document.createElement("div");
    splitSub.className = "gv-mdz-dialog-sub";
    const splitByYearCheckbox = document.createElement("input");
    splitByYearCheckbox.type = "checkbox";
    splitByYearCheckbox.id = "gv-mdz-split-by-year";
    splitByYearCheckbox.checked = true;
    const splitByYearLabel = document.createElement("label");
    splitByYearLabel.setAttribute("for", "gv-mdz-split-by-year");
    splitByYearLabel.textContent = "Split into one file per year (recommended for long conversations)";
    splitSub.append(splitByYearCheckbox, splitByYearLabel);

    const scopeYears = buildScopeOption("years", "Select Year(s)");
    const yearsSub = document.createElement("div");
    yearsSub.className = "gv-mdz-dialog-sub";
    const fromYearInput = document.createElement("input");
    fromYearInput.type = "number";
    fromYearInput.min = "1990";
    fromYearInput.max = String(currentYear);
    fromYearInput.placeholder = "From";
    fromYearInput.value = String(currentYear);
    fromYearInput.disabled = true;
    const toYearInput = document.createElement("input");
    toYearInput.type = "number";
    toYearInput.min = "1990";
    toYearInput.max = String(currentYear);
    toYearInput.placeholder = "To";
    toYearInput.value = String(currentYear);
    toYearInput.disabled = true;
    yearsSub.append("From ", fromYearInput, " To ", toYearInput);

    const scopeDateRange = buildScopeOption("dateRange", "Date Range");
    const dateSub = document.createElement("div");
    dateSub.className = "gv-mdz-dialog-sub";
    const fromDateInput = document.createElement("input");
    fromDateInput.type = "date";
    fromDateInput.disabled = true;
    const toDateInput = document.createElement("input");
    toDateInput.type = "date";
    toDateInput.disabled = true;
    dateSub.append("From ", fromDateInput, " To ", toDateInput);

    dialog.append(
      scopeAll.row, splitSub,
      scopeYears.row, yearsSub,
      scopeDateRange.row, dateSub
    );

    const scopeRadios = [scopeAll.radio, scopeYears.radio, scopeDateRange.radio];
    const syncScopeEnabled = () => {
      splitByYearCheckbox.disabled = !scopeAll.radio.checked;
      fromYearInput.disabled = !scopeYears.radio.checked;
      toYearInput.disabled = !scopeYears.radio.checked;
      fromDateInput.disabled = !scopeDateRange.radio.checked;
      toDateInput.disabled = !scopeDateRange.radio.checked;
      updateFilenamePreview();
    };
    for (const radio of scopeRadios) radio.addEventListener("change", syncScopeEnabled);
    for (const input of [fromYearInput, toYearInput, fromDateInput, toDateInput]) {
      input.addEventListener("input", updateFilenamePreview);
    }

    // --- Output format ---
    const divider1 = document.createElement("hr");
    divider1.className = "gv-mdz-dialog-divider";
    dialog.appendChild(divider1);

    const formatRow = document.createElement("div");
    formatRow.className = "gv-mdz-dialog-row";
    const formatLabelText = document.createElement("span");
    formatLabelText.textContent = "Output options";
    const mdzOption = buildFormatOption("mdz", ".mdz", EXPORT_FILE_EXTENSION === "mdz");
    const zipOption = buildFormatOption("zip", ".zip", EXPORT_FILE_EXTENSION === "zip");
    const formatHintLink = document.createElement("label");
    formatHintLink.className = "gv-mdz-dialog-link";
    formatHintLink.textContent = "What's the difference?";
    formatRow.append(formatLabelText, mdzOption.label, zipOption.label, formatHintLink);
    dialog.appendChild(formatRow);

    const formatHint = document.createElement("div");
    formatHint.className = "gv-mdz-dialog-hint";
    formatHint.style.display = "none";
    formatHint.innerHTML = FORMAT_HINT_HTML;
    formatHintLink.addEventListener("click", () => {
      formatHint.style.display = formatHint.style.display === "none" ? "block" : "none";
    });
    dialog.appendChild(formatHint);
    for (const option of [mdzOption, zipOption]) option.radio.addEventListener("change", updateFilenamePreview);

    // --- Filename ---
    const filenameWrap = document.createElement("div");
    filenameWrap.className = "gv-mdz-dialog-filename";
    const filenameLabel = document.createElement("span");
    filenameLabel.textContent = "Filename:";
    const filenameInput = document.createElement("input");
    filenameInput.type = "text";
    let filenameManuallyEdited = false;
    filenameInput.addEventListener("input", () => { filenameManuallyEdited = true; });
    filenameWrap.append(filenameLabel, filenameInput);
    dialog.appendChild(filenameWrap);

    function updateFilenamePreview() {
      if (filenameManuallyEdited) return;
      const extension = zipOption.radio.checked ? "zip" : "mdz";
      filenameInput.value = `${computeDefaultFilenameBase(contactLabel, currentScopeSelection())}.${extension}`;
    }

    function currentScopeSelection() {
      if (scopeYears.radio.checked) return { scope: "years", fromYear: fromYearInput.value, toYear: toYearInput.value };
      if (scopeDateRange.radio.checked) return { scope: "dateRange", fromDate: fromDateInput.value, toDate: toDateInput.value };
      return { scope: "all", splitByYear: splitByYearCheckbox.checked };
    }

    updateFilenamePreview();

    // --- Actions ---
    const actions = document.createElement("div");
    actions.className = "gv-mdz-dialog-actions";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "gv-mdz-dialog-btn gv-mdz-dialog-btn-secondary";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", () => overlay.remove());

    const exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.className = "gv-mdz-dialog-btn gv-mdz-dialog-btn-primary";
    exportButton.textContent = "Export";
    exportButton.addEventListener("click", () => {
      const selection = currentScopeSelection();

      if (selection.scope === "years") {
        if (!/^\d{4}$/.test(selection.fromYear) || !/^\d{4}$/.test(selection.toYear)) {
          showStatus("Enter a 4-digit year in both Year fields.");
          return;
        }
      }
      if (selection.scope === "dateRange") {
        if (!selection.fromDate || !selection.toDate) {
          showStatus("Choose both From and To dates.");
          return;
        }
      }

      const fileExtension = zipOption.radio.checked ? "zip" : "mdz";
      const typedName = filenameInput.value.trim();
      const filenameOverride = filenameManuallyEdited && typedName ? typedName : null;

      overlay.remove();
      const startedAt = Date.now();
      exportCurrentConversation({ ...selection, fileExtension, filenameOverride })
        .catch((error) => reportError(error, Date.now() - startedAt));
    });

    actions.append(cancelButton, exportButton);
    dialog.appendChild(actions);

    document.body.appendChild(overlay);

    function buildScopeOption(value, labelText, checked = false) {
      const row = document.createElement("div");
      row.className = "gv-mdz-dialog-option";
      const label = document.createElement("label");
      label.className = "gv-mdz-dialog-option-label";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "gv-mdz-scope";
      radio.value = value;
      radio.checked = checked;
      label.append(radio, document.createTextNode(labelText));
      row.appendChild(label);
      return { row, radio };
    }

    function buildFormatOption(value, labelText, checked) {
      const label = document.createElement("label");
      label.style.display = "inline-flex";
      label.style.alignItems = "center";
      label.style.gap = "4px";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "gv-mdz-format";
      radio.value = value;
      radio.checked = checked;
      label.append(radio, document.createTextNode(labelText));
      return { label, radio };
    }
  }

  function computeDefaultFilenameBase(contactLabel, selection) {
    if (selection.scope === "years") {
      const from = selection.fromYear;
      const to = selection.toYear;
      return from === to ? `gv-export-${contactLabel}-${from}` : `gv-export-${contactLabel}-${from}-to-${to}`;
    }
    if (selection.scope === "dateRange") {
      return `gv-export-${contactLabel}-${selection.fromDate}-to-${selection.toDate}`;
    }
    return `gv-export-${contactLabel}-up-to-${formatDateForFilename(new Date())}`;
  }

  // Normalizes the dialog's scope selection into what the rest of the
  // pipeline needs: a human label for progress text, the earliest/latest
  // Date the scroll/sweep loops can stop at, and a filter predicate (null
  // means "keep everything", i.e. the "entire conversation" scope).
  function buildRangeInfo({ scope, fromYear, toYear, fromDate, toDate }) {
    if (scope === "years") {
      const lo = Math.min(Number(fromYear), Number(toYear));
      const hi = Math.max(Number(fromYear), Number(toYear));
      return {
        scope,
        label: lo === hi ? String(lo) : `${lo}-${hi}`,
        earliestBoundaryDate: new Date(lo, 0, 1),
        latestBoundaryDate: new Date(hi, 11, 31, 23, 59, 59, 999),
        filter: (message) => {
          if (!message.timestampDate) return false;
          const year = message.timestampDate.getFullYear();
          return year >= lo && year <= hi;
        }
      };
    }

    if (scope === "dateRange") {
      const parsedFrom = new Date(`${fromDate}T00:00:00`);
      const parsedTo = new Date(`${toDate}T23:59:59.999`);
      const inOrder = parsedFrom <= parsedTo;
      const lo = inOrder ? parsedFrom : parsedTo;
      const hi = inOrder ? parsedTo : parsedFrom;
      return {
        scope,
        label: inOrder ? `${fromDate} to ${toDate}` : `${toDate} to ${fromDate}`,
        earliestBoundaryDate: lo,
        latestBoundaryDate: hi,
        filter: (message) => message.timestampDate && message.timestampDate >= lo && message.timestampDate <= hi
      };
    }

    return { scope: "all", label: null, earliestBoundaryDate: null, latestBoundaryDate: null, filter: null };
  }

  async function exportCurrentConversation(options = {}) {
    const {
      scope = "all",
      fromYear = null,
      toYear = null,
      fromDate = null,
      toDate = null,
      fileExtension = EXPORT_FILE_EXTENSION,
      filenameOverride = null,
      splitByYear = true
    } = options;

    ensureMdzipCore();

    const exportStartedAt = Date.now();
    const range = buildRangeInfo({ scope, fromYear, toYear, fromDate, toDate });
    const button = document.getElementById(BUTTON_ID);
    exportCancelRequested = false;
    multiYearNoticeShown = false;
    // Captured up front from the export dialog (scope "all" only) instead
    // of always defaulting true and asking again mid-scroll via the
    // multi-year notice — that notice now only informs, it no longer
    // offers a "keep as one file" button, since this decision already
    // happened before scrolling ever started.
    forceSingleFileOverride = !splitByYear;
    saveProgressCheckpoint({ phase: "starting", messageCount: 0, scope, rangeLabel: range.label });
    setBusy(button, true);

    try {
      updateProgress(range.label ? `Loading history (looking for ${range.label})...` : "Loading history...");

      const collector = createCollector();
      const scrollResult = await autoScrollAndCollect(collector, range);

      updateProgress(range.label ? `Scanning conversation (${range.label})...` : "Scanning conversation...");
      const sweepResult = await sweepLoadedConversation(collector, range);

      updateProgress("Reading messages...");
      collectVisibleMessages(collector);

      let messages = Array.from(collector.messages.values()).sort(compareMessages);
      if (messages.length === 0) {
        if (exportCancelRequested) {
          showStatus("Canceled — no messages were collected yet.");
          return;
        }
        throw new Error("No Google Voice messages were found in the currently open conversation.");
      }

      if (range.filter) {
        messages = messages.filter(range.filter);
        if (messages.length === 0) {
          if (exportCancelRequested) {
            showStatus(`Canceled before reaching ${range.label} — no matching messages were collected yet.`);
            return;
          }
          throw new Error(`No messages found for ${range.label} in the currently open conversation.`);
        }
      }

      collector.diagnostics.messageCount = messages.length;
      collector.diagnostics.firstTimestamp = messages[0]?.timestampIso || messages[0]?.timestampText || "";
      collector.diagnostics.lastTimestamp = messages[messages.length - 1]?.timestampIso || messages[messages.length - 1]?.timestampText || "";
      collector.diagnostics.finderCounts = summarizeFinderCounts();

      const yearGroups = range.filter ? new Map([[range.label, messages]]) : groupMessagesByYear(messages);
      const chunked = scope === "all" && !forceSingleFileOverride && yearGroups.size > 1;
      const exportGroups = chunked ? yearGroups : new Map([["all", messages]]);
      const parts = [];
      let partIndex = 0;

      for (const [yearLabel, yearMessages] of exportGroups) {
        partIndex += 1;
        updateProgress(chunked
          ? `Packaging ${yearLabel} (${yearMessages.length} messages)...`
          : range.label
          ? `Packaging ${range.label} (${yearMessages.length} messages)...`
          : `Packaging ${yearMessages.length} messages...`);
        saveProgressCheckpoint({
          phase: "packaging",
          part: yearLabel,
          index: partIndex,
          total: exportGroups.size,
          messageCount: messages.length
        });

        const packageResult = await buildMdz(yearMessages, {
          warnings: [...scrollResult.warnings, ...sweepResult.warnings],
          steps: scrollResult.steps
        }, collector.diagnostics, chunked ? {
          label: yearLabel,
          index: partIndex,
          total: exportGroups.size,
          count: yearMessages.length,
          totalCount: messages.length
        } : null, {
          rangeLabel: range.label,
          fileExtension,
          // A user-typed filename only makes sense for a single output file —
          // if this turned out to need year-chunking after all (unknowable
          // until scrolling finished), fall back to the per-year default
          // rather than reusing one name for every part.
          filenameOverride: exportGroups.size === 1 ? filenameOverride : null
        });

        updateProgress(chunked
          ? `Starting download (${yearLabel})...`
          : range.label
          ? `Starting download (${range.label})...`
          : "Starting download...");
        downloadBlob(packageResult.blob, packageResult.filename);
        parts.push({ filename: packageResult.filename, count: yearMessages.length, bytes: packageResult.blob.size });
      }

      showExportSuccess(parts, Date.now() - exportStartedAt);
    } finally {
      clearProgressCheckpoint();
      document.querySelector(".gv-mdz-multi-year-notice")?.remove();
      setBusy(button, false);
    }
  }

  function ensureMdzipCore() {
    if (typeof MdzipCore === "undefined") {
      throw new Error("MdzipCore is not loaded. Check the userscript manager's @require access to jsDelivr.");
    }
  }

  function requestExportCancel() {
    if (exportCancelRequested) return;
    exportCancelRequested = true;
    showStatus("Canceling — finishing up with what's been collected so far...");
  }

  function setBusy(button, busy) {
    if (!button) return;
    activeButton = busy ? button : null;
    button.classList.toggle("gv-mdz-busy", busy);
    button.innerHTML = busy ? CANCEL_ICON_SVG : DOWNLOAD_ICON_SVG;
    const label = busy ? "Exporting… Click to cancel." : "Export this conversation to MDZip";
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  function updateProgress(message) {
    if (activeButton) {
      activeButton.title = message;
      activeButton.setAttribute("aria-label", message);
    }
    showStatus(message);
  }

  const STATUS_HISTORY_CAP = 100;

  function ensureProgressPanel() {
    let panel = document.querySelector(".gv-mdz-progress-panel");
    if (panel) return panel;

    panel = document.createElement("div");
    panel.className = "gv-mdz-progress-panel";

    const header = document.createElement("div");
    header.className = "gv-mdz-progress-header";

    const title = document.createElement("span");
    title.className = "gv-mdz-progress-title";
    title.textContent = APP_NAME;

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "gv-mdz-progress-close";
    closeButton.setAttribute("aria-label", "Dismiss");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", () => panel.remove());

    header.append(title, closeButton);

    const current = document.createElement("div");
    current.className = "gv-mdz-progress-current";

    const history = document.createElement("div");
    history.className = "gv-mdz-progress-history";

    panel.append(header, current, history);
    document.body.appendChild(panel);
    return panel;
  }

  // No default hideAfterMs: ongoing progress (scrolling/scanning/packaging)
  // should stay visible with its running history rather than blinking away
  // mid-run just because two updates happened to be more than a few seconds
  // apart — that flicker was the actual complaint, not the panel itself.
  // Only explicit terminal calls (success, "reached the top") pass
  // STATUS_SUCCESS_HIDE_MS to auto-dismiss once nothing more is coming.
  function showStatus(message, hideAfterMs = null) {
    const panel = ensureProgressPanel();
    const current = panel.querySelector(".gv-mdz-progress-current");
    const history = panel.querySelector(".gv-mdz-progress-history");

    current.textContent = message;

    const line = document.createElement("div");
    line.className = "gv-mdz-progress-history-line";
    line.textContent = `${new Date().toLocaleTimeString()} — ${message}`;
    history.appendChild(line);
    while (history.children.length > STATUS_HISTORY_CAP) {
      history.removeChild(history.firstChild);
    }
    history.scrollTop = history.scrollHeight;

    clearTimeout(showStatus.hideTimer);
    if (hideAfterMs) {
      showStatus.hideTimer = setTimeout(() => panel.remove(), hideAfterMs);
    }
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
  }

  function formatDurationSeconds(totalSeconds) {
    const seconds = Math.round(totalSeconds);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

  function showExportSuccess(parts, elapsedMs) {
    const totalMessages = parts.reduce((sum, part) => sum + part.count, 0);
    const totalBytes = parts.reduce((sum, part) => sum + (part.bytes || 0), 0);
    const sizeText = formatBytes(totalBytes);
    const durationText = formatDurationSeconds(elapsedMs / 1000);
    const filenames = parts.map((part) => part.filename).join(", ");

    const message = parts.length > 1
      ? `Exported ${totalMessages} messages across ${parts.length} files (${sizeText} total) in ${durationText}. Check your Downloads folder for: ${filenames}`
      : `Exported ${totalMessages} messages (${sizeText}) in ${durationText}. Check your Downloads folder for ${filenames}.`;
    showStatus(message, STATUS_SUCCESS_HIDE_MS);

    if (!parts[0].filename.endsWith(".mdz")) return;
    if (localStorage.getItem(HIDE_TIP_STORAGE_KEY) === "1") return;
    showExportTip();
  }

  function showExportTip() {
    document.querySelector(".gv-mdz-tip")?.remove();

    const panel = document.createElement("div");
    panel.className = "gv-mdz-tip";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "gv-mdz-tip-close";
    closeButton.setAttribute("aria-label", "Dismiss");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", () => panel.remove());

    const text = document.createElement("div");
    text.innerHTML = `Don't recognize <strong>.mdz</strong>? Rename it to <strong>.zip</strong> to open anywhere, or view it free at <a href="https://mdzip.org" target="_blank" rel="noopener noreferrer">mdzip.org</a>.`;

    const row = document.createElement("label");
    row.className = "gv-mdz-tip-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        localStorage.setItem(HIDE_TIP_STORAGE_KEY, "1");
      } else {
        localStorage.removeItem(HIDE_TIP_STORAGE_KEY);
      }
    });

    row.append(checkbox, document.createTextNode("Don't show this tip again"));
    panel.append(closeButton, text, row);
    document.body.appendChild(panel);
  }

  // A modal summary for scroll-to-top, shown in addition to the progress
  // panel's status line. The status line auto-hides after
  // STATUS_SUCCESS_HIDE_MS, which is easy to miss on a run that takes
  // several minutes and the user isn't actively watching — this instead
  // sits there until explicitly dismissed, so stepping away and coming
  // back still shows a clear, unmissable "here's what happened."
  function showScrollToTopSummaryDialog({ outcome, steps, elapsedMs, finalHeight }) {
    document.querySelector(".gv-mdz-dialog-overlay")?.remove();

    const heading = {
      done: "Reached the top",
      canceled: "Scroll to top canceled",
      maxSteps: "Stopped without confirming the top"
    }[outcome];

    const overlay = document.createElement("div");
    overlay.className = "gv-mdz-dialog-overlay";
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) overlay.remove();
    });

    const dialog = document.createElement("div");
    dialog.className = "gv-mdz-dialog";
    overlay.appendChild(dialog);

    const headingEl = document.createElement("h2");
    headingEl.textContent = heading;
    dialog.appendChild(headingEl);

    const stats = document.createElement("div");
    stats.className = "gv-mdz-dialog-hint";
    stats.innerHTML = [
      `<div>Steps: ${steps.toLocaleString()}</div>`,
      `<div>Time: ${formatDurationSeconds(elapsedMs / 1000)}</div>`,
      `<div>Conversation height loaded: ${finalHeight.toLocaleString()}px</div>`
    ].join("");
    dialog.appendChild(stats);

    const actions = document.createElement("div");
    actions.className = "gv-mdz-dialog-actions";
    const okButton = document.createElement("button");
    okButton.type = "button";
    okButton.className = "gv-mdz-dialog-btn gv-mdz-dialog-btn-primary";
    okButton.textContent = "OK";
    okButton.addEventListener("click", () => overlay.remove());
    actions.appendChild(okButton);
    dialog.appendChild(actions);

    document.body.appendChild(overlay);
  }

  function collectedYearCount(collector) {
    const years = new Set();
    for (const message of collector.messages.values()) {
      years.add(message.timestampDate ? message.timestampDate.getFullYear() : "unknown-date");
    }
    return years.size;
  }

  function checkMultiYearNotice(collector) {
    // forceSingleFileOverride means the user already decided against
    // splitting up front in the export dialog — nothing to notify about.
    if (multiYearNoticeShown || forceSingleFileOverride || collectedYearCount(collector) <= 1) return;
    multiYearNoticeShown = true;
    showMultiYearNotice();
  }

  // Informational only — the split-vs-single-file decision now happens up
  // front in the export dialog (splitByYear checkbox), so this no longer
  // offers a "keep as one file" button mid-scroll to ask again.
  function showMultiYearNotice() {
    document.querySelector(".gv-mdz-tip")?.remove();

    const panel = document.createElement("div");
    panel.className = "gv-mdz-tip gv-mdz-multi-year-notice";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "gv-mdz-tip-close";
    closeButton.setAttribute("aria-label", "Dismiss");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", () => panel.remove());

    const text = document.createElement("div");
    text.textContent = "This conversation spans multiple years — it'll be split into one file per year, and may take a while to finish scrolling through the full history. Click the export button again any time to stop early and download what's been collected so far.";

    panel.append(closeButton, text);
    document.body.appendChild(panel);
  }

  function reportError(error, elapsedMs) {
    console.error(`[${APP_NAME}]`, error);
    const suffix = typeof elapsedMs === "number" ? ` (after ${formatDurationSeconds(elapsedMs / 1000)})` : "";
    showStatus(`Export failed${suffix}: ${error.message || error}`);
  }

  function createCollector() {
    return {
      messages: new Map(),
      seenQuickKeys: new Set(),
      firstSeenIndex: 0,
      diagnostics: {
        scrollContainers: describeScrollContainers(),
        finderCounts: {},
        collectedBySelector: {}
      }
    };
  }

  async function autoScrollAndCollect(collector, range = { scope: "all", label: null, earliestBoundaryDate: null }) {
    const messageList = findMessageList();
    const scrollContainer = findScrollContainer(messageList);
    const warnings = [];

    collectVisibleMessages(collector);

    if (!scrollContainer) {
      warnings.push("Could not identify a conversation scroll container; exported only currently loaded messages.");
      return { warnings, steps: 0 };
    }

    let stableOldestChecks = 0;
    let lastOldestKey = getOldestCollectedKey(collector);

    for (let step = 0; step < MAX_SCROLL_STEPS; step += 1) {
      if (exportCancelRequested) {
        warnings.push("Export canceled by user; some older messages may not have loaded.");
        return { warnings, steps: step };
      }

      const scrollMonthLabel = getOldestCollectedMonthLabel(collector);
      updateProgress(range.label
        ? (scrollMonthLabel
          ? `Scrolling through ${scrollMonthLabel}, looking for ${range.label} (${countCollectedInRange(collector, range)} matching messages so far)`
          : `Scroll page ${step + 1}, looking for ${range.label} (${countCollectedInRange(collector, range)} matching messages so far)`)
        : (scrollMonthLabel
          ? `Scrolling through ${scrollMonthLabel} (${collector.messages.size} messages found)`
          : `Scroll page ${step + 1} (${collector.messages.size} messages found)`));
      pulseScrollUp(scrollContainer);
      await wait(SCROLL_PAUSE_MS);

      collectVisibleMessages(collector);
      if (range.scope === "all") checkMultiYearNotice(collector);
      saveProgressCheckpoint({ phase: "scroll", step: step + 1, messageCount: collector.messages.size });

      if (range.earliestBoundaryDate) {
        const oldestDate = getOldestCollectedDate(collector);
        if (oldestDate && oldestDate < range.earliestBoundaryDate) {
          // Scrolled past the requested range into older history — nothing
          // further back can still match, so stop early instead of
          // scrolling all the way to the true top.
          return { warnings, steps: step + 1 };
        }
      }

      const oldestKey = getOldestCollectedKey(collector);
      const oldestUnchanged = oldestKey === lastOldestKey;

      if (oldestUnchanged) {
        stableOldestChecks += 1;
      } else {
        stableOldestChecks = 0;
      }

      if (stableOldestChecks >= TOP_STABLE_CHECKS && scrollContainer.scrollTop <= 2) {
        return { warnings, steps: step + 1 };
      }

      lastOldestKey = oldestKey;
    }

    warnings.push(`Auto-scroll stopped after ${MAX_SCROLL_STEPS} steps; some older messages may not have loaded.`);
    return { warnings, steps: MAX_SCROLL_STEPS };
  }

  function pulseScrollUp(scrollContainer) {
    const distance = Math.max(900, Math.floor(scrollContainer.clientHeight * 1.4));
    scrollContainer.dispatchEvent(new WheelEvent("wheel", { deltaY: -distance, bubbles: true, cancelable: true }));
    scrollContainer.scrollBy?.({ top: -distance, behavior: "auto" });
    scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollTop - distance);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -distance, bubbles: true, cancelable: true }));
  }

  // Originally jumped straight to scrollTop 0 on every call, on the theory
  // that a decisive "go to the top" jump would trigger the same fast path a
  // manual click-the-scrollbar-track does. Diagnostics disproved that: half
  // the steps stalled for 13-30s with *no* matching network request in the
  // Resource Timing log and no loading spinner visible — Google Voice's
  // "check for more history" listener simply wasn't firing on those calls.
  // A hard jump-to-absolute-zero apparently doesn't read as continued
  // scrolling the way an incremental nudge does (same as pulseScrollUp,
  // which never showed this stall pattern across a real 436-step export).
  // So this now decrements from the current position like pulseScrollUp,
  // while keeping the unstick nudge below for when it's already pinned at 0.
  //
  // `allowUnstick` caps how long that nudge keeps firing: once genuinely at
  // the top with nothing left to load, `scrollTop <= 2` is permanently
  // true, so without a cap this bounces down-and-back-up forever (visibly,
  // and confusingly — live testing showed it never settling because the
  // bounce's transient re-render sometimes gets read as fresh content by
  // the caller's topmost-message check). The caller passes false once it's
  // confirmed the nudge isn't turning anything up, so the loop can settle.
  async function jumpScrollToTop(scrollContainer, allowUnstick = true) {
    const distance = Math.max(900, Math.floor(scrollContainer.clientHeight * 1.4));

    // If already pinned at 0 (the normal state after the previous pulse),
    // decrementing from 0 is a no-op — the value doesn't change, so the
    // browser fires no native 'scroll' event, and Google Voice's own "check
    // for more history" listener never re-arms. That's exactly what
    // manually scrolling down a touch and back up avoids. Nudge down first
    // to force a genuine, observable transition before scrolling back up.
    if (allowUnstick && scrollContainer.scrollTop <= 2) {
      const nudge = Math.max(60, Math.floor(scrollContainer.clientHeight * 0.2));
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { deltaY: nudge, bubbles: true, cancelable: true }));
      scrollContainer.scrollTop = nudge;
      await unthrottledWait(150);
    }

    scrollContainer.dispatchEvent(new WheelEvent("wheel", { deltaY: -distance, bubbles: true, cancelable: true }));
    scrollContainer.scrollBy?.({ top: -distance, behavior: "auto" });
    scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollTop - distance);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -distance, bubbles: true, cancelable: true }));
  }

  // Reads just enough of the topmost currently-rendered message item to
  // detect whether scrolling revealed an older one — no cloneNode, unlike
  // extractMessage. Used as a second "did this step make progress" signal
  // alongside scrollHeight: live testing showed Google Voice's message list
  // (almost certainly Angular CDK virtual-scroll) has two scrollbar-thumb
  // behaviors — for the first few loads the thumb resizes/repositions
  // proportionally as the estimated scrollHeight grows with each fetch, but
  // after enough history is loaded the thumb settles into a constant small
  // size pinned near the top and stops moving that way. That's consistent
  // with the virtual scroll's height *estimate* leveling off independently
  // of whether more real history is still being fetched — meaning
  // scrollHeight comparisons alone can go stale and report "no progress"
  // even while older messages are genuinely still being prepended.
  function getTopmostMessageSignature(scrollContainer) {
    const item = scrollContainer.querySelector("gv-message-item");
    if (!item) return "";
    return extractTimestampText(item) || (item.textContent || "").slice(0, 80);
  }

  // Polls for either scrollHeight growth or the topmost rendered message
  // changing (Google Voice prepending older messages it just fetched)
  // instead of sleeping a fixed duration — the equivalent of watching the
  // scrollbar for space to open up above the thumb, plus watching the
  // conversation itself for older content to appear (in case the thumb's
  // own height estimate stops moving, see getTopmostMessageSignature).
  // Starts checking frequently and backs off the poll interval the longer
  // nothing changes, so a fast-loading conversation moves fast and a slow
  // one still eventually gets a long-enough look before giving up on this
  // pulse.
  async function waitForScrollGrowth(scrollContainer, previousHeight, previousSignature, options = {}) {
    const {
      minPollMs = 120,
      maxPollMs = SCROLL_PAUSE_MS,
      backoffFactor = 1.4,
      maxTotalWaitMs = SCROLL_PAUSE_MS * 8
    } = options;

    // `requestedTotal` only decides when to give up (same backoff budget as
    // before). The returned `waited` is measured wall-clock time — if a
    // background tab gets throttled, the requested delays stay the same but
    // this will reflect how long it actually took, instead of silently
    // under-reporting it the way summing the nominal pollMs values would.
    const startedAt = Date.now();
    let pollMs = minPollMs;
    let requestedTotal = 0;

    while (requestedTotal < maxTotalWaitMs) {
      await unthrottledWait(pollMs);
      requestedTotal += pollMs;
      const heightChanged = scrollContainer.scrollHeight !== previousHeight;
      const signatureChanged = getTopmostMessageSignature(scrollContainer) !== previousSignature;
      // heightChanged alone is not trustworthy here: a 738-step live run
      // showed scrollHeight oscillating between two values (a ~25px flip)
      // every step once pinned at the top, caused by jumpScrollToTop's own
      // unstick nudge perturbing the virtual-scroll's height estimate —
      // with signatureChanged correctly staying false the whole time, and
      // only flipping true once real content actually arrived. Treating
      // heightChanged as "grew" on its own kept resetting the unstick
      // attempt cap every step (since "grew" resets it), bouncing forever.
      // signatureChanged reflects the actual conversation content and
      // isn't fooled by that noise, so it's the sole signal for real
      // progress; heightChanged is kept only for diagnostics.
      if (signatureChanged) {
        return { grew: true, waited: Date.now() - startedAt, heightChanged, signatureChanged };
      }
      pollMs = Math.min(maxPollMs, Math.round(pollMs * backoffFactor));
    }

    return { grew: false, waited: Date.now() - startedAt, heightChanged: false, signatureChanged: false };
  }

  // Captures the same per-request timing DevTools' Network tab shows (via
  // the Resource Timing API) without needing a human watching it live.
  // Answers "is the slowness us or Google Voice's backend" directly: each
  // entry's elapsedMs/durationMs can be lined up against the step log in
  // SCROLL_DIAGNOSTICS_KEY to see whether a slow step was actually waiting
  // on a slow request, or idle for some other reason.
  function startNetworkCapture() {
    const perfStartedAt = performance.now();
    const entries = [];

    // Persisted on every batch, not just at stop() — a run that crashes or
    // hangs instead of finishing cleanly would otherwise lose this entirely,
    // unlike the step-by-step diagnostics log.
    const persist = () => {
      try {
        localStorage.setItem(SCROLL_NETWORK_LOG_KEY, JSON.stringify(entries));
      } catch {
        // Storage can throw (quota, private mode); network log is best-effort.
      }
    };

    if (typeof PerformanceObserver === "undefined") {
      return { stop: () => entries };
    }

    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        entries.push({
          name: entry.name,
          elapsedMs: Math.round(entry.startTime - perfStartedAt),
          durationMs: Math.round(entry.duration),
          transferSize: entry.transferSize || 0,
          initiatorType: entry.initiatorType
        });
      }
      persist();
    });

    try {
      observer.observe({ type: "resource", buffered: false });
    } catch {
      // Unsupported or blocked; network capture is best-effort.
    }

    return {
      stop() {
        observer.disconnect();
        persist();
        return entries;
      }
    };
  }

  function scrollToTopOrCancel() {
    if (scrollToTopActive) {
      if (scrollToTopCancelRequested) return;
      scrollToTopCancelRequested = true;
      showStatus("Canceling scroll to top — stopping after the current step...");
      return;
    }
    scrollConversationToTop();
  }

  // Standalone "just scroll to the top" command — no message collection, no
  // export. Useful on its own (loads full history so in-page search/Ctrl+F
  // covers the whole conversation) and doubles as an isolated test bed for
  // tuning the adaptive scroll-growth polling above without waiting through
  // a full export to see the effect.
  async function scrollConversationToTop() {
    if (scrollToTopActive) {
      showStatus("Already scrolling to top — please wait.");
      return;
    }

    const messageList = findMessageList();
    const scrollContainer = findScrollContainer(messageList);
    if (!scrollContainer) {
      showStatus("Could not identify the conversation's scroll container.");
      return;
    }

    scrollToTopActive = true;
    scrollToTopCancelRequested = false;
    const startedAt = Date.now();
    const networkCapture = startNetworkCapture();
    // Kept in-memory and rewritten to localStorage each step — small enough
    // (a few hundred bytes per step, capped by MAX_SCROLL_STEPS) that this
    // isn't worth throttling, and it means the full run is inspectable
    // afterward (JSON.parse(localStorage.getItem(...))) without having had
    // devtools open and console history retained for the whole run.
    const log = [];
    const recordDiagnostic = (entry) => {
      log.push({ ...entry, elapsedMs: Date.now() - startedAt });
      try {
        localStorage.setItem(SCROLL_DIAGNOSTICS_KEY, JSON.stringify(log));
      } catch {
        // Storage can throw (quota, private mode); diagnostics are best-effort.
      }
    };

    // How many times to bounce (nudge down, snap back up) once already
    // pinned at scrollTop 0 before giving up on that trick and just
    // settling in place. Without a cap this bounces forever once genuinely
    // at the top (scrollTop <= 2 stays true with nothing left to load),
    // which is both visibly distracting and can spuriously look like
    // "grew" if the bounce's transient re-render gets caught mid-poll —
    // preventing TOP_STABLE_CHECKS from ever being reached.
    const MAX_UNSTICK_ATTEMPTS = 3;

    try {
      let stableChecks = 0;
      let unstickAttempts = 0;
      let step = 0;

      while (step < MAX_SCROLL_STEPS) {
        if (scrollToTopCancelRequested) {
          recordDiagnostic({ done: false, canceled: true, totalSteps: step });
          showStatus(`Canceled after ${step} steps.`, STATUS_SUCCESS_HIDE_MS);
          showScrollToTopSummaryDialog({ outcome: "canceled", steps: step, elapsedMs: Date.now() - startedAt, finalHeight: scrollContainer.scrollHeight });
          return;
        }

        step += 1;
        const beforeHeight = scrollContainer.scrollHeight;
        const beforeSignature = getTopmostMessageSignature(scrollContainer);
        const wasAtTop = scrollContainer.scrollTop <= 2;
        const allowUnstick = !wasAtTop || unstickAttempts < MAX_UNSTICK_ATTEMPTS;
        if (wasAtTop) unstickAttempts += 1;
        await jumpScrollToTop(scrollContainer, allowUnstick);

        // Google Voice only fetches more history once scrollTop actually
        // reaches 0 — diagnostics showed scrollTop coasting down smoothly
        // (12682 -> 10298 -> 7914 -> ...) with scrollHeight never budging
        // in between, yet the old code sat through the full patient
        // exponential-backoff wait (13-53s measured) on every single one of
        // those steps anyway, on the *chance* something might load. Only
        // pay for the patient wait once we're actually at the boundary;
        // everywhere else a single short check is enough.
        const atBoundary = scrollContainer.scrollTop <= 2;
        const { grew, waited, heightChanged, signatureChanged } = atBoundary
          ? await waitForScrollGrowth(scrollContainer, beforeHeight, beforeSignature)
          : await waitForScrollGrowth(scrollContainer, beforeHeight, beforeSignature, { minPollMs: 100, maxPollMs: 100, maxTotalWaitMs: 100 });
        const afterHeight = scrollContainer.scrollHeight;
        recordDiagnostic({ step, grew, waited, atBoundary, heightChanged, signatureChanged, heightBefore: beforeHeight, heightAfter: afterHeight, scrollTop: scrollContainer.scrollTop });
        showStatus(`Scrolling to top… step ${step}, ${grew ? "loaded more" : "no change"} (waited ${waited}ms, height ${afterHeight}px)`);

        stableChecks = grew ? 0 : stableChecks + 1;
        if (grew) unstickAttempts = 0;

        if (stableChecks >= TOP_STABLE_CHECKS && scrollContainer.scrollTop <= 2) {
          const elapsedMs = Date.now() - startedAt;
          const seconds = (elapsedMs / 1000).toFixed(1);
          recordDiagnostic({ done: true, totalSteps: step, totalSeconds: Number(seconds) });
          showStatus(`Reached the top after ${step} steps (${seconds}s).`, STATUS_SUCCESS_HIDE_MS);
          showScrollToTopSummaryDialog({ outcome: "done", steps: step, elapsedMs, finalHeight: scrollContainer.scrollHeight });
          return;
        }
      }

      recordDiagnostic({ done: false, stoppedAtMaxSteps: true, totalSteps: MAX_SCROLL_STEPS });
      showStatus(`Stopped after ${MAX_SCROLL_STEPS} steps without confirming the top.`, STATUS_SUCCESS_HIDE_MS);
      showScrollToTopSummaryDialog({ outcome: "maxSteps", steps: MAX_SCROLL_STEPS, elapsedMs: Date.now() - startedAt, finalHeight: scrollContainer.scrollHeight });
    } finally {
      networkCapture.stop();
      scrollToTopActive = false;
    }
  }

  function getOldestCollectedKey(collector) {
    const messages = Array.from(collector.messages.values());
    if (messages.length === 0) return "";
    messages.sort(compareMessages);
    const oldest = messages[0];
    return oldest.timestampIso || oldest.timestampText || oldest.fingerprint;
  }

  function getOldestCollectedDate(collector) {
    let oldest = null;
    for (const message of collector.messages.values()) {
      if (!message.timestampDate) continue;
      if (!oldest || message.timestampDate < oldest) oldest = message.timestampDate;
    }
    return oldest;
  }

  function getNewestCollectedDate(collector) {
    let newest = null;
    for (const message of collector.messages.values()) {
      if (!message.timestampDate) continue;
      if (!newest || message.timestampDate > newest) newest = message.timestampDate;
    }
    return newest;
  }

  function countCollectedInRange(collector, range) {
    if (!range.filter) return collector.messages.size;
    let count = 0;
    for (const message of collector.messages.values()) {
      if (range.filter(message)) count += 1;
    }
    return count;
  }

  // The oldest collected message's month/year — a human-readable stand-in
  // for "how far back have we scrolled," since scrolling moves backward in
  // time and this is the trailing edge of what's been reached so far.
  function getOldestCollectedMonthLabel(collector) {
    const oldest = getOldestCollectedDate(collector);
    return oldest ? new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(oldest) : null;
  }

  // Unlike waitForScrollGrowth (which waits on a real network fetch), the
  // sweep pass only needs Google Voice's virtualized list to re-render the
  // DOM window around a scroll position it's already fetched — no network
  // involved. Polls quickly and returns as soon as the topmost rendered
  // item changes instead of always sleeping the full budget, since that
  // re-render is normally fast (a single change-detection cycle).
  async function waitForRenderSettle(scrollContainer, previousSignature, maxWaitMs = 200) {
    const pollMs = 30;
    let waited = 0;
    while (waited < maxWaitMs) {
      await unthrottledWait(pollMs);
      waited += pollMs;
      if (getTopmostMessageSignature(scrollContainer) !== previousSignature) return;
    }
  }

  async function sweepLoadedConversation(collector, range = { scope: "all", label: null }) {
    const messageList = findMessageList();
    const scrollContainer = findScrollContainer(messageList);
    const warnings = [];

    if (!scrollContainer) {
      warnings.push("Could not sweep loaded conversation because no scroll container was found.");
      return { warnings, positions: 0 };
    }

    scrollContainer.scrollTop = 0;
    await wait(SCROLL_PAUSE_MS * 2);
    collectVisibleMessages(collector);

    let positions = 0;
    let lastHeight = scrollContainer.scrollHeight;
    let lastTop = -1;
    const stepSize = Math.max(250, Math.floor(scrollContainer.clientHeight * 0.65));
    const totalPages = Math.floor(scrollContainer.scrollHeight / stepSize) + 1;

    for (let top = 0; top <= scrollContainer.scrollHeight; top += stepSize) {
      if (exportCancelRequested) {
        warnings.push("Export canceled by user during the scan pass; some messages may be missing.");
        break;
      }

      const beforeSweepSignature = getTopmostMessageSignature(scrollContainer);
      scrollContainer.scrollTop = top;
      await waitForRenderSettle(scrollContainer, beforeSweepSignature);
      collectVisibleMessages(collector);
      if (range.scope === "all") checkMultiYearNotice(collector);
      positions += 1;
      saveProgressCheckpoint({ phase: "sweep", step: positions, messageCount: collector.messages.size });

      if (range.latestBoundaryDate) {
        const newestDate = getNewestCollectedDate(collector);
        if (newestDate && newestDate > range.latestBoundaryDate) {
          // Swept forward past the requested range's upper bound — nothing
          // further down (newer) can still match, so stop here instead of
          // continuing to sweep all the way to the present. Without this,
          // e.g. selecting years 2015-2020 still swept every message all
          // the way to today before the year filter discarded the rest.
          break;
        }
      }

      const sweepMonthLabel = getOldestCollectedMonthLabel(collector);
      updateProgress(range.label
        ? (sweepMonthLabel
          ? `Scanning through ${sweepMonthLabel}, looking for ${range.label} (${countCollectedInRange(collector, range)} matching messages so far)`
          : `Scan page ${positions}/${totalPages}, looking for ${range.label} (${countCollectedInRange(collector, range)} matching messages so far)`)
        : (sweepMonthLabel
          ? `Scanning through ${sweepMonthLabel} (${collector.messages.size} messages found)`
          : `Scan page ${positions}/${totalPages} (${collector.messages.size} messages found)`));

      if (scrollContainer.scrollHeight !== lastHeight) {
        lastHeight = scrollContainer.scrollHeight;
      }

      if (Math.abs(scrollContainer.scrollTop - lastTop) < 2 && top > 0) {
        break;
      }
      lastTop = scrollContainer.scrollTop;
    }

    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    await wait(100);

    return { warnings, positions };
  }

  function collectVisibleMessages(collector) {
    for (const item of findMessageItems()) {
      // extractMessage() does 2-3 full cloneNode(true) passes per item (to
      // safely read text without mutating the live DOM). Google Voice's
      // virtualized list re-renders mostly-the-same window on every scroll
      // step, so most visible items here were already extracted last step —
      // this quick, clone-free check skips re-doing that work for them.
      const quickKey = buildQuickDedupKey(item);
      if (quickKey && collector.seenQuickKeys.has(quickKey)) continue;

      const message = extractMessage(item, collector.firstSeenIndex);
      if (!message || (!message.text && message.attachments.length === 0)) continue;

      if (quickKey) collector.seenQuickKeys.add(quickKey);

      const key = message.fingerprint;
      if (!collector.messages.has(key)) {
        collector.messages.set(key, message);
        collector.firstSeenIndex += 1;
        collector.diagnostics.collectedBySelector[message.selectorSource] =
          (collector.diagnostics.collectedBySelector[message.selectorSource] || 0) + 1;
      }
    }
  }

  // Cheap enough to run on every visible item every scroll step: no cloning,
  // just direct property reads. Collision risk (same timestamp, same text
  // length, same first 80 chars, but a genuinely different message) is
  // negligible for chat text and would only cause that one message to be
  // skipped, not corrupt anything else.
  function buildQuickDedupKey(item) {
    const timestampText = extractTimestampText(item);
    const rawText = item.textContent || "";
    if (!timestampText && !rawText) return "";
    return `${timestampText}␟${rawText.length}␟${rawText.slice(0, 80)}`;
  }

  function findMessageList() {
    return (
      document.querySelector("gv-thread-details-pane-content gv-message-list") ||
      document.querySelector("gv-thread-details gv-message-list") ||
      document.querySelector("gv-message-list")
    );
  }

  function findMessageItems() {
    const pane = document.querySelector("gv-thread-details-pane-content") || document.querySelector("gv-thread-details") || document;
    const directItems = Array.from(pane.querySelectorAll("gv-message-list gv-message-item"));
    const fallbackItems = Array.from(pane.querySelectorAll("gv-message-item"));
    const timestampItems = findTimestampAnchoredMessageItems(pane);
    return uniqueElements([...directItems, ...fallbackItems, ...timestampItems]);
  }

  function findTimestampAnchoredMessageItems(pane) {
    return Array.from(pane.querySelectorAll(".cdk-visually-hidden, [aria-label], time, [datetime]"))
      .filter((node) => looksLikeFullDateTime(cleanText(node.getAttribute("datetime") || node.getAttribute("aria-label") || node.textContent || "")))
      .map((node) => closestMessageLikeElement(node))
      .filter(Boolean)
      .filter((node) => !node.closest("gv-thread-list, gv-message-thread-list-item, gv-thread-list-item, gv-contact-list"));
  }

  function closestMessageLikeElement(node) {
    const preferred = node.closest("gv-message-item, li, [role='listitem'], [class*='message'], [class*='bubble']");
    if (preferred) return preferred;

    let current = node.parentElement;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      const text = cleanText(current.textContent || "");
      if (text.length > 0 && text.length < 10000 && current.querySelector("img, gv-annotation, .cdk-visually-hidden")) {
        return current;
      }
    }
    return null;
  }

  function uniqueElements(elements) {
    const seen = new Set();
    return elements.filter((element) => {
      if (!element || seen.has(element)) return false;
      seen.add(element);
      return true;
    });
  }

  function findScrollContainer(start) {
    let node = start;
    while (node && node !== document.body && node !== document.documentElement) {
      if (isScrollable(node) && node.querySelector?.("gv-message-item, .cdk-visually-hidden")) return node;
      node = node.parentElement;
    }

    const candidates = getScrollableCandidates();
    candidates.sort((a, b) => scoreScrollContainer(b) - scoreScrollContainer(a));
    return candidates[0] || document.scrollingElement;
  }

  function scoreScrollContainer(element) {
    const rect = element.getBoundingClientRect();
    const messageScore = element.querySelectorAll("gv-message-item").length * 100;
    const timestampScore = Array.from(element.querySelectorAll(".cdk-visually-hidden, [aria-label], time, [datetime]"))
      .filter((node) => looksLikeFullDateTime(cleanText(node.getAttribute("datetime") || node.getAttribute("aria-label") || node.textContent || ""))).length * 50;
    const viewportScore = Math.min(rect.height, 1200);
    const scrollScore = Math.min(element.scrollHeight - element.clientHeight, 5000) / 10;
    return messageScore + timestampScore + viewportScore + scrollScore;
  }

  function isScrollable(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const overflowY = style.overflowY;
    return /(auto|scroll)/.test(overflowY) && element.scrollHeight > element.clientHeight + 20;
  }

  function extractMessage(item, fallbackIndex) {
    const timestampText = extractTimestampText(item);
    const normalizedTimestamp = normalizeTimestamp(timestampText);
    const sender = extractSender(item);
    const text = extractMessageText(item, sender, timestampText);
    const links = extractLinks(item);
    const attachments = extractAttachments(item);
    const avatarUrl = extractAvatarUrl(item);
    const avatarMonogram = avatarUrl ? null : extractAvatarMonogram(item);
    const orderHint = normalizedTimestamp ? normalizedTimestamp.getTime() : fallbackIndex;
    const fingerprint = [
      normalizedTimestamp ? normalizedTimestamp.toISOString() : "",
      sender,
      text,
      attachments.map((attachment) => attachment.url || attachment.label).join("|")
    ].join("\u001f");

    return {
      sender,
      timestampText,
      timestampIso: normalizedTimestamp ? toLocalIso(normalizedTimestamp) : "",
      timestampDate: normalizedTimestamp,
      text,
      links,
      attachments,
      avatarUrl,
      avatarMonogram,
      orderHint,
      seenIndex: fallbackIndex,
      fingerprint,
      selectorSource: item.tagName.toLowerCase()
    };
  }

  function extractAvatarUrl(item) {
    const img = item.querySelector("gv-avatar img, [class*='avatar'] img");
    if (!img) return "";

    return img.currentSrc || img.src || img.getAttribute("src") || "";
  }

  function extractAvatarMonogram(item) {
    const monogram = item.querySelector("[class*='avatar'] [class*='monogram']");
    if (!monogram) return null;

    const letter = cleanText(monogram.textContent || "");
    if (!letter) return null;

    const avatarRoot = monogram.closest("[class*='avatar']");
    const color = (avatarRoot && avatarRoot.style && avatarRoot.style.backgroundColor) || "";

    return { letter, color };
  }

  function extractTimestampText(item) {
    const hiddenCandidates = Array.from(item.querySelectorAll(".cdk-visually-hidden, [aria-label], time, [datetime]"))
      .map((node) => node.getAttribute("datetime") || node.getAttribute("aria-label") || node.textContent || "")
      .map(cleanText)
      .filter(Boolean);

    const candidate =
      hiddenCandidates.find(looksLikeFullDateTime) ||
      hiddenCandidates.find(looksLikeTime) ||
      cleanText(item.querySelector(".timestamp")?.textContent || "");

    return extractDateTimeSubstring(candidate) || candidate;
  }

  function extractSender(item) {
    const direction = getMessageDirection(item);

    if (direction === "outgoing") {
      return "Me";
    }

    if (direction === "incoming") {
      return getIncomingSenderName(item);
    }

    // No outgoing/incoming DOM class was found at all. Fall back to the same
    // structural signal getIncomingSenderName uses (Google's own generated
    // "Message from X" accessibility label, or a dedicated sender element) —
    // never scan raw message body text for keywords, since ordinary prose
    // ("thanks, you rock") can trivially false-match that kind of heuristic.
    const senderCandidate = Array.from(item.querySelectorAll(".sender, [class*='sender'], [class*='author'], .cdk-visually-hidden"))
      .map((node) => cleanText(node.textContent || node.getAttribute("aria-label") || ""))
      .map(sanitizeSender)
      .find((value) => value && !looksLikeFullDateTime(value) && !looksLikeTime(value));

    return senderCandidate || "Contact";
  }

  function getMessageDirection(item) {
    const directionSelector = "[class*='outgoing'], [class*='incoming'], [class*='self']";
    const directionNode = item.querySelector?.(directionSelector) || item.closest?.(directionSelector);
    if (!directionNode) return "";

    const classes = ` ${String(directionNode.className || "")} `;
    if (/\boutgoing\b|\bself\b/i.test(classes)) return "outgoing";
    if (/\bincoming\b/i.test(classes)) return "incoming";
    return "";
  }

  function getIncomingSenderName(item) {
    const senderCandidate = Array.from(item.querySelectorAll(".sender, [class*='sender'], [class*='author'], .cdk-visually-hidden"))
      .map((node) => sanitizeSender(node.textContent || node.getAttribute("aria-label") || ""))
      .find((value) => value && value !== "Me" && !looksLikeFullDateTime(value) && !looksLikeTime(value));

    return senderCandidate || getConversationTitle() || "Contact";
  }

  function extractMessageText(item, sender, timestampText) {
    const clone = item.cloneNode(true);
    replaceInlineImageText(clone);

    for (const node of clone.querySelectorAll([
      "button",
      "mat-icon",
      "gv-message-actions",
      "gv-attachment-list",
      "gv-image-attachment",
      "video",
      "audio",
      ".timestamp",
      ".cdk-visually-hidden",
      "[aria-hidden='true'] mat-icon"
    ].join(","))) {
      node.remove();
    }

    const textCandidates = Array.from(item.querySelectorAll("gv-annotation[aria-label], gv-annotation, [class*='message'] gv-annotation, [class*='text']"))
      .map((node) => cleanMessageBody(readRenderedText(node) || node.getAttribute("aria-label") || node.textContent || ""))
      .filter((value) => value && !looksLikeFullDateTime(value) && !looksLikeUiText(value));

    const bestCandidate = textCandidates.sort((a, b) => b.length - a.length)[0];
    const fallback = cleanMessageBody(readRenderedText(clone) || clone.textContent || "");
    return stripLeadingMessageMetadata(cleanMessageBody(bestCandidate || fallback), sender, timestampText);
  }

  function extractLinks(item) {
    const attachmentContainers = "gv-attachment-list, gv-image-attachment, [class*='attachment']";
    return Array.from(item.querySelectorAll("a[href]"))
      .filter((node) => !node.closest(attachmentContainers))
      .map((node) => ({
        url: node.href,
        label: cleanText(node.textContent || node.getAttribute("aria-label") || node.href)
      }))
      .filter((link, index, links) => link.url && links.findIndex((candidate) => candidate.url === link.url) === index);
  }

  function extractAttachments(item) {
    const attachments = [];
    const seen = new Set();
    const attachmentRoots = Array.from(item.querySelectorAll("gv-attachment-list, gv-image-attachment, [class*='attachment']"));
    const roots = attachmentRoots.length > 0 ? attachmentRoots : [];
    const nodes = roots.flatMap((root) =>
      Array.from(root.querySelectorAll("img, a[href], video[src], audio[src], source[src]"))
    );

    for (const node of nodes) {
      const rawUrl = node.currentSrc || node.src || node.href || node.getAttribute("src") || node.getAttribute("href");
      if (!rawUrl || seen.has(rawUrl) || isUiAssetUrl(rawUrl)) continue;
      seen.add(rawUrl);

      const type = inferAttachmentType(node, rawUrl);
      const label = cleanText(node.alt || node.title || node.getAttribute("aria-label") || type);

      attachments.push({
        url: rawUrl,
        label,
        type
      });
    }

    return attachments;
  }

  function isUiAssetUrl(url) {
    return /voice_favicon|contacts\/.*=s\d+-c-mo|fonts\.googleapis|gstatic\.com\/.*\/icons/i.test(url);
  }

  function inferAttachmentType(node, url) {
    if (node.tagName === "IMG" || /\.(png|jpe?g|gif|webp|bmp|avif)(\?|#|$)/i.test(url) || url.startsWith("data:image/")) return "image";
    if (node.tagName === "VIDEO" || /\.(mp4|webm|mov)(\?|#|$)/i.test(url)) return "video";
    if (node.tagName === "AUDIO" || /\.(mp3|m4a|wav|ogg)(\?|#|$)/i.test(url)) return "audio";
    return "asset";
  }

  function compareMessages(a, b) {
    if (a.timestampDate && b.timestampDate && a.timestampDate.getTime() !== b.timestampDate.getTime()) {
      return a.timestampDate - b.timestampDate;
    }
    return a.seenIndex - b.seenIndex;
  }

  // Chunks a very long conversation into one archive per calendar year so a
  // single export doesn't turn into a multi-thousand-image file that chokes
  // MDZip viewers. Conversations spanning a single year are unaffected — they
  // still produce exactly one archive, same as before this existed.
  function groupMessagesByYear(messages) {
    const groups = new Map();
    for (const message of messages) {
      const key = message.timestampDate ? String(message.timestampDate.getFullYear()) : "unknown-date";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(message);
    }

    const years = Array.from(groups.keys()).filter((key) => key !== "unknown-date").sort();
    const ordered = new Map();
    for (const year of years) ordered.set(year, groups.get(year));
    if (groups.has("unknown-date")) ordered.set("unknown-date", groups.get("unknown-date"));
    return ordered;
  }

  function getMessagesContacts(messages) {
    return Array.from(new Set(messages.map((message) => message.sender)))
      .filter((sender) => sender !== "Me")
      .sort((a, b) => a.localeCompare(b));
  }

  // Used for filenames only — a full contact list would make group-chat
  // filenames unwieldy, so groups collapse to "group" (matching the
  // "Google Voice group message" heading shown for the same case).
  function getFilenameContactLabel(messages) {
    const contacts = getMessagesContacts(messages);
    return contacts.length === 1 ? contacts[0] : "group";
  }

  // Used only for the dialog's filename preview, before any messages have
  // been collected — getFilenameContactLabel() needs real message data to
  // detect a group chat, which doesn't exist yet at dialog-open time. The
  // DOM title for a group conversation is comma-separated contact names, so
  // that's used as a cheap stand-in signal to avoid previewing an absurdly
  // long filename for group chats.
  function getPreviewContactLabel() {
    const title = sanitizeConversationTitle(getConversationTitle());
    if (!title) return "conversation";
    return title.includes(",") ? "group" : safeFilename(title);
  }

  async function buildMdz(messages, scrollResult, diagnostics, partInfo = null, exportOptions = {}) {
    const { rangeLabel = null, fileExtension = EXPORT_FILE_EXTENSION, filenameOverride = null } = exportOptions;
    const files = [];
    const exportedAt = new Date();
    const title = `Google Voice conversation with ${getConversationTitle()}`;
    const assetResults = await addAssets(files, messages);
    const avatarResults = await addAvatars(files, messages);
    const warnings = [...scrollResult.warnings, ...assetResults.warnings, ...avatarResults.warnings];
    const markdown = buildMarkdown({ exportedAt, messages, warnings, partInfo });
    const contactLabel = getFilenameContactLabel(messages);
    const filenameYearPart = partInfo?.label || rangeLabel;
    const baseFilename = filenameOverride
      ? filenameOverride.replace(/\.(mdz|zip)$/i, "")
      : filenameYearPart
      ? `gv-export-${contactLabel}-${filenameYearPart}`
      : `gv-export-${contactLabel}-${formatDateForFilename(exportedAt)}`;
    const filename = `${safeFilename(baseFilename)}.${fileExtension}`;
    const diagnosticsPayload = partInfo ? { ...diagnostics, part: partInfo } : diagnostics;

    files.unshift(
      { path: "index.md", text: markdown },
      { path: "diagnostics.json", text: JSON.stringify(diagnosticsPayload, null, 2) },
      { path: "README.md", text: README_MD },
      { path: "AGENTS.md", text: AGENTS_MD }
    );

    updateProgress("Generating archive...");
    const built = await MdzipCore.MdzPackagerCore.buildArchive(files, "gv-export", {
      createIndex: false,
      mapFiles: true,
      filters: ["**/*"],
      title,
      mode: "document",
      entryPoint: "index.md",
      language: navigator.language || "en",
      description: "Exported Google Voice conversation including text and assets.",
      // buildArchive has supported this since @mdzip/core-js 1.3.2 (well
      // before the 1.4.0 CDN bundle this script already @requires) — it
      // forwards JSZip's own generateAsync progress, so this is the exact
      // compression work happening on large conversations, not a guess.
      onProgress: (progress) => {
        const percent = Math.round(progress.percent);
        updateProgress(progress.currentFile
          ? `Generating archive... ${percent}% (${progress.currentFile})`
          : `Generating archive... ${percent}%`);
      }
    });

    const manifest = {
      ...built.manifest,
      producer: {
        ...built.manifest.producer,
        application: { name: APP_NAME, version: APP_VERSION, url: APP_URL, type: "userscript" }
      },
      keywords: ["google-voice", "chat", "export", "mdzip"]
    };

    const stamped = await MdzipCore.MdzArchiveCore.updateFiles(built.blob, [], [], { manifest });
    return { blob: stamped.blob, filename };
  }

  const ASSET_DOWNLOAD_CONCURRENCY = 5;

  // Runs `worker` over `items` with at most `limit` concurrent in flight —
  // downloads are network-bound (waiting, not computing), so overlapping a
  // handful at once cuts real wall-clock time without the complexity of a
  // full task queue. Per-item failures are captured rather than thrown, so
  // one bad attachment doesn't abort the rest. Stops launching new work
  // (already-started fetches still finish) once exportCancelRequested flips.
  async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function runNext() {
      while (nextIndex < items.length && !exportCancelRequested) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = { ok: true, value: await worker(items[index], index) };
        } catch (error) {
          results[index] = { ok: false, error };
        }
      }
    }

    const workerCount = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => runNext()));
    return results;
  }

  async function addAssets(files, messages) {
    const warnings = [];
    const usedPaths = new Set();

    const tasks = [];
    for (const message of messages) {
      for (const attachment of message.attachments) {
        tasks.push({ message, attachment });
      }
    }

    const total = tasks.length;
    let completed = 0;

    // Path assignment (and therefore makeUniqueArchivePath's collision
    // numbering) must stay deterministic regardless of which download
    // finishes first, so results are collected by original index here and
    // only assigned to `files` in that same order afterward.
    const results = await mapWithConcurrency(tasks, ASSET_DOWNLOAD_CONCURRENCY, async ({ attachment }) => {
      try {
        const fetched = await fetchAsBlob(attachment.url);
        completed += 1;
        updateProgress(`Downloaded assets ${completed}/${total}`);
        return fetched;
      } catch (error) {
        completed += 1;
        updateProgress(`Skipped assets ${completed}/${total}`);
        throw error;
      }
    });

    for (let i = 0; i < tasks.length; i += 1) {
      const { message, attachment } = tasks[i];
      const result = results[i];

      if (!result || !result.ok) {
        const error = result?.error;
        attachment.error = error ? (error.message || String(error)) : "canceled before this attachment downloaded";
        warnings.push(`Could not download attachment ${attachment.url}: ${attachment.error}`);
        continue;
      }

      const fetched = result.value;
      const extension = extensionFromBlobOrUrl(fetched.blob, attachment.url, attachment.type);
      const dir = attachment.type === "image" ? "images" : "assets";
      const baseName = buildAttachmentBaseName(message, attachment);
      const path = makeUniqueArchivePath(`${dir}/${baseName}${extension}`, usedPaths);
      const bytes = new Uint8Array(await fetched.blob.arrayBuffer());

      files.push({ path, data: bytes });
      attachment.path = path;
      attachment.contentType = fetched.contentType;
    }

    if (exportCancelRequested && results.some((result) => !result || !result.ok)) {
      warnings.push("Export canceled by user; remaining attachments were not downloaded.");
    }

    return { warnings };
  }

  async function addAvatars(files, messages) {
    const warnings = [];
    const usedPaths = new Set();
    const pathsBySender = new Map();
    const monogramsBySender = new Map();

    for (const message of messages) {
      if (message.avatarMonogram && !monogramsBySender.has(message.sender)) {
        monogramsBySender.set(message.sender, message.avatarMonogram);
      }
    }

    // One task per distinct avatar URL — multiple senders sharing the exact
    // same photo URL only need it downloaded once. The first message seen
    // for a URL supplies the sender name used for its filename, matching
    // the previous sequential behavior.
    const firstMessageByUrl = new Map();
    for (const message of messages) {
      if (message.avatarUrl && !firstMessageByUrl.has(message.avatarUrl)) {
        firstMessageByUrl.set(message.avatarUrl, message);
      }
    }
    const urls = Array.from(firstMessageByUrl.keys());

    const results = await mapWithConcurrency(urls, ASSET_DOWNLOAD_CONCURRENCY, (url) => fetchAsBlob(url));

    const pathsByUrl = new Map();
    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i];
      const result = results[i];
      const sender = firstMessageByUrl.get(url).sender;

      if (!result || !result.ok) {
        const error = result?.error;
        warnings.push(`Could not download avatar for ${sender}: ${error ? (error.message || String(error)) : "canceled"}`);
        continue;
      }

      const fetched = result.value;
      const extension = extensionFromBlobOrUrl(fetched.blob, url, "image");
      const path = makeUniqueArchivePath(`images/avatars/${safeFilename(sender)}${extension}`, usedPaths);
      const bytes = new Uint8Array(await fetched.blob.arrayBuffer());

      files.push({ path, data: bytes });
      pathsByUrl.set(url, path);
    }

    for (const message of messages) {
      if (message.avatarUrl && pathsByUrl.has(message.avatarUrl) && !pathsBySender.has(message.sender)) {
        pathsBySender.set(message.sender, pathsByUrl.get(message.avatarUrl));
      }
    }

    for (const [sender, monogram] of monogramsBySender) {
      if (pathsBySender.has(sender)) continue;

      const path = makeUniqueArchivePath(`images/avatars/${safeFilename(sender)}.svg`, usedPaths);
      files.push({ path, text: buildMonogramSvg(monogram.letter, monogram.color) });
      pathsBySender.set(sender, path);
    }

    for (const message of messages) {
      const path = pathsBySender.get(message.sender);
      if (path) message.avatarPath = path;
    }

    return { warnings };
  }

  function buildMonogramSvg(letter, color) {
    const size = 128;
    const fill = escapeHtmlAttribute(color || "#5f6368");
    const label = escapeHtmlAttribute(letter);
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
      `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${fill}"/>`,
      `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${size * 0.5}" font-weight="600" fill="#ffffff">${label}</text>`,
      `</svg>`
    ].join("");
  }

  function buildAttachmentBaseName(message, attachment) {
    const timestamp = message.timestampDate
      ? formatDateTimeForFilename(message.timestampDate)
      : safeFilename(extractDateTimeSubstring(message.timestampText) || message.timestampText || "unknown-time");
    const sender = safeFilename(message.sender);
    const typeSuffix = attachment.type && attachment.type !== "image" ? `-${safeFilename(attachment.type)}` : "";
    return `${timestamp}-${sender}${typeSuffix}`;
  }

  function makeUniqueArchivePath(path, usedPaths) {
    const dotIndex = path.lastIndexOf(".");
    const stem = dotIndex >= 0 ? path.slice(0, dotIndex) : path;
    const extension = dotIndex >= 0 ? path.slice(dotIndex) : "";
    let candidate = path;
    let counter = 2;

    while (usedPaths.has(candidate)) {
      candidate = `${stem}-${counter}${extension}`;
      counter += 1;
    }

    usedPaths.add(candidate);
    return candidate;
  }

  function fetchAsBlob(url) {
    if (url.startsWith("data:")) {
      return Promise.resolve(dataUriToBlob(url));
    }

    return withTimeout(fetchWithTimeout(url, ASSET_FETCH_TIMEOUT_MS)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob().then((blob) => ({
          blob,
          contentType: response.headers.get("content-type") || blob.type || ""
        }));
      })
      .catch((fetchError) => {
        if (typeof GM_xmlhttpRequest !== "function") throw fetchError;
        return fetchWithGm(url);
      }), ASSET_FETCH_TIMEOUT_MS + 5000, "Attachment download timeout");
  }

  function withTimeout(promise, timeoutMs, message) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { credentials: "include", signal: controller.signal })
      .finally(() => clearTimeout(timer));
  }

  function fetchWithGm(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "blob",
        timeout: ASSET_FETCH_TIMEOUT_MS,
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`HTTP ${response.status}`));
            return;
          }
          const contentType = parseHeader(response.responseHeaders || "", "content-type") || response.response?.type || "";
          resolve({ blob: response.response, contentType });
        },
        onerror: () => reject(new Error("Network error")),
        ontimeout: () => reject(new Error("Network timeout"))
      });
    });
  }

  function dataUriToBlob(url) {
    const commaIndex = url.indexOf(",");
    const header = url.slice(0, commaIndex);
    const data = url.slice(commaIndex + 1);
    const contentType = /^data:([^;,]+)/.exec(header)?.[1] || "";
    const isBase64 = /;base64/i.test(header);
    const bytes = isBase64 ? atob(data) : decodeURIComponent(data);
    const array = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) array[i] = bytes.charCodeAt(i);
    return { blob: new Blob([array], { type: contentType }), contentType };
  }

  function parseHeader(headers, name) {
    const pattern = new RegExp(`^${name}:\\s*(.+)$`, "im");
    return pattern.exec(headers)?.[1]?.trim() || "";
  }

  function extensionFromBlobOrUrl(blob, url, type) {
    const urlExt = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(new URL(url, location.href).pathname)?.[1];
    if (urlExt) return `.${urlExt.toLowerCase()}`;

    const mime = blob.type || "";
    const byMime = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/avif": ".avif",
      "video/mp4": ".mp4",
      "video/webm": ".webm",
      "audio/mpeg": ".mp3",
      "audio/mp4": ".m4a",
      "audio/wav": ".wav",
      "application/pdf": ".pdf"
    };
    return byMime[mime] || (type === "image" ? ".jpg" : ".bin");
  }

  const AVATAR_SIZE_PX = 28;

  function buildAvatarTag(message) {
    if (!message.avatarPath) return "";
    return `<img src="${encodeMarkdownPath(message.avatarPath)}" alt="${escapeHtmlAttribute(message.sender)}" width="${AVATAR_SIZE_PX}" height="${AVATAR_SIZE_PX}" style="border-radius:50%;vertical-align:middle;object-fit:cover;"> `;
  }

  function buildMessageLines(message) {
    const lines = [];
    const timestamp = message.timestampDate ? formatTimeOnly(message.timestampDate) : message.timestampText || "Unknown time";
    const avatarTag = buildAvatarTag(message);
    lines.push(`${avatarTag}**${escapeMarkdown(message.sender)}** ${escapeMarkdown(timestamp)}`, "");

    if (message.text) {
      lines.push(message.text, "");
    }

    for (const link of message.links) {
      if (!message.text.includes(link.url)) {
        lines.push(`[${escapeMarkdown(link.label || link.url)}](<${link.url.replace(/>/g, "%3E")}>)`, "");
      }
    }

    for (const attachment of message.attachments) {
      if (attachment.path) {
        const label = attachment.label || attachment.type;
        if (attachment.type === "image") {
          lines.push(`![${escapeMarkdown(label)}](${encodeMarkdownPath(attachment.path)})`, "");
        } else {
          lines.push(`[${escapeMarkdown(label)}](${encodeMarkdownPath(attachment.path)})`, "");
        }
      } else {
        lines.push(`_Attachment unavailable: ${escapeMarkdown(attachment.label || attachment.url)}_`, "");
      }
    }

    return lines;
  }

  function buildMarkdown({ exportedAt, messages, warnings, partInfo }) {
    const contacts = getMessagesContacts(messages);

    const heading = contacts.length > 1
      ? "Google Voice group message"
      : `Google Voice conversation with ${contacts[0] || "Unknown Contact"}`;

    const phoneNumbersByContact = getContactPhoneNumbers();
    const fallbackPhoneNumber = contacts.length === 1 ? getHeaderPhoneNumber() : "";

    const lines = [
      `# ${escapeMarkdown(heading)}`,
      "",
      `Exported: ${formatExportedAt(exportedAt)}\\`,
      `By: [${APP_NAME}](${APP_URL}) version ${APP_VERSION}`,
      ...(partInfo
        ? [`Part: ${escapeMarkdown(partInfo.label)} — ${partInfo.count} of ${partInfo.totalCount} messages (file ${partInfo.index} of ${partInfo.total})`]
        : []),
      "",
      "## Contacts:",
      "",
      ...contacts.map((contact) => {
        const phone = phoneNumbersByContact.get(contact.toLowerCase()) || fallbackPhoneNumber;
        return `- ${escapeMarkdown(contact)}${phone ? ` — ${phone}` : ""}`;
      }),
      "",
      "---",
      ""
    ];

    let currentDay = "";
    for (const message of messages) {
      const day = message.timestampDate ? formatDateHeading(message.timestampDate) : "Unknown date";
      if (day !== currentDay) {
        currentDay = day;
        lines.push(`## ${day}`, "");
      }

      const messageLines = buildMessageLines(message);
      if (message.sender === "Me") {
        lines.push(`<div style="text-align:right">`, "", ...messageLines, "</div>", "");
      } else {
        lines.push(...messageLines);
      }
    }

    if (warnings.length > 0) {
      lines.push("## Export Warnings", "");
      for (const warning of warnings) {
        lines.push(`- ${escapeMarkdown(warning)}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  function getConversationTitle() {
    const header = findConversationHeader();
    const titleCandidates = header ? getHeaderTitleCandidates(header) : [];
    const fallback = document.title.replace(/^Voice\s*-\s*/i, "").replace(/^Messages\s+with\s+/i, "");
    return sanitizeConversationTitle(titleCandidates[0] || fallback || "Google Voice conversation");
  }

  function getHeaderPhoneNumber() {
    const header = findConversationHeader();
    if (!header) return "";

    const phonePattern = /\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/;
    const candidates = Array.from(header.querySelectorAll("h1, h2, [class*='name'], [class*='title'], [class*='phone'], gv-annotation, span, div"))
      .flatMap((node) => {
        const rendered = readRenderedText(node);
        const aria = node.getAttribute("aria-label") || "";
        return [rendered, aria, node.textContent || ""];
      })
      .flatMap((value) => String(value || "").split(/\n+/))
      .map(cleanText)
      .map((value) => phonePattern.exec(value)?.[0] || "")
      .filter(Boolean);

    return candidates[0] || "";
  }

  function getContactPhoneNumbers() {
    const panel = document.querySelector("gv-people-and-options");
    const map = new Map();
    if (!panel) return map;

    const phonePattern = /\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/;
    for (const item of panel.querySelectorAll("[role='listitem']")) {
      const nameNode = item.querySelector("[class*='title']");
      const subtitleNode = item.querySelector("[class*='subtitle']");
      if (!nameNode) continue;

      const name = sanitizeSender(cleanText(nameNode.textContent || ""));
      const phone = phonePattern.exec(cleanText(subtitleNode?.textContent || ""))?.[0] || "";
      if (name && phone) {
        map.set(name.toLowerCase(), phone);
      }
    }

    return map;
  }

  function getHeaderTitleCandidates(header) {
    const preferredSelectors = [
      "h1",
      "h2",
      "[class*='name']",
      "[class*='title']",
      "gv-annotation",
      "span",
      "div"
    ];

    return Array.from(header.querySelectorAll(preferredSelectors.join(",")))
      .flatMap((node) => {
        const rendered = readRenderedText(node);
        const aria = node.getAttribute("aria-label") || "";
        return [rendered, aria, node.textContent || ""];
      })
      .flatMap((value) => String(value || "").split(/\n+/))
      .map(sanitizeConversationTitle)
      .filter((value) => value && !looksLikeUiText(value) && !looksLikePhoneText(value) && value.length <= 80)
      .filter((value, index, values) => values.indexOf(value) === index);
  }

  function sanitizeConversationTitle(value) {
    let title = cleanText(value)
      .replace(/^Messages\s+with\s+/i, "")
      .replace(/\bphone\b/gi, " ")
      .replace(/\bmore_vert\b/gi, " ")
      .replace(/\bExport MDZip\b/gi, " ")
      .replace(/\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g, " ")
      .replace(/\b(?:\d\s+){6,}\d\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (title.includes("•")) {
      title = cleanText(title.split("•")[0]);
    }

    title = title.replace(/\s+(?:Mobile|Home|Work|Main|Other|Google Voice)\s*$/i, "").trim();
    title = collapseDuplicatedPhrase(title);

    return title;
  }

  function looksLikePhoneText(value) {
    const text = cleanText(value);
    return /\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/.test(text) || /^(?:\d\s*){7,}$/.test(text);
  }

  function summarizeFinderCounts() {
    const pane = document.querySelector("gv-thread-details-pane-content") || document.querySelector("gv-thread-details") || document;
    return {
      directMessageItems: pane.querySelectorAll("gv-message-list gv-message-item").length,
      allMessageItems: pane.querySelectorAll("gv-message-item").length,
      fullTimestampAnchors: Array.from(pane.querySelectorAll(".cdk-visually-hidden, [aria-label], time, [datetime]"))
        .filter((node) => looksLikeFullDateTime(cleanText(node.getAttribute("datetime") || node.getAttribute("aria-label") || node.textContent || ""))).length,
      timestampAnchoredItems: findTimestampAnchoredMessageItems(pane).length
    };
  }

  function describeScrollContainers() {
    return getScrollableCandidates().map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        className: String(element.className || ""),
        scrollTop: Math.round(element.scrollTop),
        scrollHeight: Math.round(element.scrollHeight),
        clientHeight: Math.round(element.clientHeight),
        rect: {
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        messageItems: element.querySelectorAll("gv-message-item").length,
        fullTimestampAnchors: Array.from(element.querySelectorAll(".cdk-visually-hidden, [aria-label], time, [datetime]"))
          .filter((node) => looksLikeFullDateTime(cleanText(node.getAttribute("datetime") || node.getAttribute("aria-label") || node.textContent || ""))).length
      };
    });
  }

  function getScrollableCandidates() {
    const pane = document.querySelector("gv-thread-details-pane-content") || document.querySelector("gv-thread-details") || document;
    const candidates = Array.from(pane.querySelectorAll("*")).filter(isScrollable);
    if (document.scrollingElement && isScrollable(document.scrollingElement)) candidates.push(document.scrollingElement);
    return uniqueElements(candidates);
  }

  function downloadBlob(blob, filename) {
    if (typeof GM_download === "function") {
      const url = URL.createObjectURL(blob);
      GM_download({
        url,
        name: filename,
        saveAs: true,
        onload: () => URL.revokeObjectURL(url),
        onerror: () => {
          URL.revokeObjectURL(url);
          downloadWithAnchor(blob, filename);
        }
      });
      return;
    }

    downloadWithAnchor(blob, filename);
  }

  function downloadWithAnchor(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function normalizeTimestamp(value) {
    const cleaned = cleanText(extractDateTimeSubstring(value) || value || "");
    if (!cleaned) return null;

    const direct = new Date(cleaned);
    if (!Number.isNaN(direct.getTime())) return direct;

    const withCommaBeforeYear = cleaned.replace(/(\b[A-Z][a-z]+ \d{1,2}) (\d{4}\b)/, "$1, $2");
    const parsed = new Date(withCommaBeforeYear);
    if (!Number.isNaN(parsed.getTime())) return parsed;

    return null;
  }

  function toLocalIso(date) {
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absolute = Math.abs(offsetMinutes);
    const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().replace("Z", "");
    return `${local}${offset}`;
  }

  function formatDateHeading(date) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "2-digit"
    }).format(date);
  }

  function formatTimeOnly(date) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  function formatExportedAt(date) {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  function formatDateForFilename(date) {
    return toLocalIso(date).slice(0, 10);
  }

  function formatDateTimeForFilename(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day}-${hours}${minutes}`;
  }

  function cleanMessageText(value) {
    return cleanText(value)
      .replace(/\bMore options\b/gi, "")
      .replace(/\bMessage actions\b/gi, "")
      .trim();
  }

  function cleanMessageBody(value) {
    return String(value || "")
      .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => cleanMessageText(line))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function sanitizeSender(value) {
    let sender = cleanText(value);
    if (!sender) return "";
    if (/\bmessage (?:from|to) you\b|\bsent by you\b/i.test(sender)) return "Me";

    const fullDate = extractDateTimeSubstring(sender);
    if (fullDate) sender = sender.replace(fullDate, " ");

    sender = sender
      .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\.?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.? \d{1,2},? \d{4}\b/gi, " ")
      .replace(/\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/gi, " ")
      .replace(/\bMessage from\b/i, " ")
      .replace(/\bMessage to\b/i, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (sender.includes("•")) {
      sender = sender.split("•").map((part) => cleanText(part)).find(Boolean) || sender;
    }

    if (sender.includes(",")) {
      sender = cleanText(sender.split(",")[0]);
    }

    sender = sender.replace(/\s+(?:Mobile|Home|Work|Main|Other|Google Voice)\s*$/i, "").trim();
    sender = collapseDuplicatedPhrase(sender);

    return sender || "Contact";
  }

  function collapseDuplicatedPhrase(value) {
    const match = /^(.+?)\s+\1$/.exec(String(value || "").trim());
    return match ? match[1] : value;
  }

  function stripLeadingMessageMetadata(text, sender, timestampText) {
    let lines = String(text || "").split("\n");
    const senderPattern = sender && sender !== "Contact" ? escapeRegExp(sender) : "";
    const dateTime = extractDateTimeSubstring(timestampText);

    while (lines.length > 0) {
      const line = cleanText(lines[0]);
      if (!line) {
        lines.shift();
        continue;
      }

      const isDateLine = (dateTime && line.includes(dateTime)) || looksLikeFullDateTime(line) || looksLikeTime(line);
      const isSenderOnly = senderPattern && new RegExp(`^${senderPattern}\\s*$`, "i").test(line);
      const isSenderMetadata = senderPattern && new RegExp(`^${senderPattern}\\s*(?:[•:,\\-]|$)`, "i").test(line);

      if (isDateLine || isSenderOnly || isSenderMetadata) {
        if (isSenderMetadata) {
          const remainder = line.replace(new RegExp(`^${senderPattern}\\s*[•:,\\-]\\s*`, "i"), "").trim();
          if (remainder && !looksLikeFullDateTime(remainder) && !looksLikeTime(remainder) && !/^[A-Z]$/.test(remainder)) {
            lines[0] = remainder;
            break;
          }
        }
        lines.shift();
        continue;
      }

      break;
    }

    return lines.join("\n").trim();
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function readRenderedText(node) {
    if (!node) return "";
    const clone = node.cloneNode(true);
    replaceInlineImageText(clone);
    return typeof clone.innerText === "string" ? clone.innerText : "";
  }

  function replaceInlineImageText(root) {
    for (const image of Array.from(root.querySelectorAll("img"))) {
      if (image.closest("gv-attachment-list, gv-image-attachment, [class*='attachment']")) continue;

      const label = image.alt || image.title || image.getAttribute("aria-label") || "";
      if (label) {
        image.replaceWith(document.createTextNode(label));
      }
    }
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function looksLikeFullDateTime(value) {
    return /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+[A-Z][a-z]+ \d{1,2} \d{4},?\s+\d{1,2}:\d{2}\s*(?:AM|PM)\b/i.test(value);
  }

  function extractDateTimeSubstring(value) {
    const cleaned = cleanText(value || "");
    return /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+[A-Z][a-z]+ \d{1,2} \d{4},?\s+\d{1,2}:\d{2}\s*(?:AM|PM)\b/i.exec(cleaned)?.[0] || "";
  }

  function looksLikeTime(value) {
    return /\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/i.test(value);
  }

  function looksLikeUiText(value) {
    return /^(Call|More|More options|Messages|Voice|Search|Send|Image|Photo|Download|Export MDZip|Exporting\.\.\.)$/i.test(value);
  }

  function escapeMarkdown(value) {
    return String(value || "").replace(/([\\`*_{}[\]()#+.!|-])/g, "\\$1");
  }

  function escapeHtmlAttribute(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function encodeMarkdownPath(path) {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  function safeFilename(value) {
    return String(value || "gv-export")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "gv-export";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
