(() => {
  const OVERLAY_ID = "touch-grass-mode-overlay";
  const MAX_SCAN_TEXT_CHARS = 250000;
  const SUPPORT_SNIPPET_RADIUS = 90;
  const THROTTLE_MS = 1500;

  const DEFAULT_SETTINGS = {
    enabledDomains: ["app.hyperliquid.xyz"],
    lossThresholdUsd: 500,
    cooldownMinutes: 15,
    keywords: ["Realized PnL", "Realized PNL", "Daily PnL", "Daily PNL", "Today's PnL", "Portfolio PnL", "Account PnL", "PnL", "PNL"],
    emergencyUnlockDelaySeconds: 60
  };

  let settings = { ...DEFAULT_SETTINGS };
  let lastScanAt = 0;
  let countdownTimer = null;
  let observer = null;

  init();

  async function init() {
    settings = await loadSettings();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      for (const key of Object.keys(changes)) {
        settings[key] = changes[key].newValue;
      }
      syncScannerState("settings_changed");
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      handleMessage(message).then(sendResponse).catch((error) => {
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
      return true;
    });

    await rehydrateOverlayIfNeeded();

    syncScannerState("initial_load");
  }

  async function handleMessage(message) {
    if (!message || typeof message.type !== "string") {
      return { ok: false, error: "Missing message type" };
    }

    if (message.type === "SUPPORT_CHECK") {
      settings = await loadSettings();
      const result = runSupportCheck();
      return { ok: true, ...result };
    }

    if (message.type === "TRIGGER_TEST_OVERLAY") {
      await activateCooldown({
        loss: -Math.abs(numberSetting("lossThresholdUsd", DEFAULT_SETTINGS.lossThresholdUsd)),
        reason: "Manual test trigger",
        snippet: "Manual test trigger from Touch Grass Mode popup."
      });
      return { ok: true };
    }

    if (message.type === "CLEAR_OVERLAY") {
      await clearCooldownForCurrentDomain();
      removeOverlay();
      return { ok: true };
    }

    return { ok: false, error: `Unknown message type: ${message.type}` };
  }

  async function loadSettings() {
    try {
      const stored = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
      return { ...DEFAULT_SETTINGS, ...stored };
    } catch (error) {
      console.warn("Touch Grass Mode: failed to load settings", error);
      return { ...DEFAULT_SETTINGS };
    }
  }

  function numberSetting(key, fallback) {
    const value = Number(settings[key]);
    return Number.isFinite(value) ? value : fallback;
  }

  function isEnabledForThisDomain() {
    const hostname = window.location.hostname;
    const domains = Array.isArray(settings.enabledDomains) ? settings.enabledDomains : [];
    return domains.some((domain) => domainMatches(hostname, domain));
  }

  function domainMatches(hostname, domainPattern) {
    const clean = String(domainPattern || "")
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/:\d+$/, "")
      .toLowerCase();

    if (!clean) return false;
    const host = hostname.toLowerCase();
    if (clean === "*") return true;
    if (clean.startsWith("*.")) {
      const suffix = clean.slice(2);
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    return host === clean || host.endsWith(`.${clean}`);
  }

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      if (mutations.every((mutation) => isInsideOverlay(mutation.target))) return;
      throttledCheck("dom_mutation");
    });
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function stopObserver() {
    if (observer) observer.disconnect();
    observer = null;
  }

  function syncScannerState(reason) {
    if (isEnabledForThisDomain()) {
      startObserver();
      throttledCheck(reason);
      return;
    }

    stopObserver();
    removeOverlay();
  }

  function isInsideOverlay(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return Boolean(element?.closest?.(`#${OVERLAY_ID}`));
  }

  function throttledCheck(reason) {
    const now = Date.now();
    if (now - lastScanAt < THROTTLE_MS) return;
    lastScanAt = now;
    checkForLoss(reason).catch((error) => {
      console.warn("Touch Grass Mode: loss check failed", error);
    });
  }

  async function checkForLoss(reason) {
    if (!isEnabledForThisDomain()) return;

    const active = await getActiveCooldownForCurrentDomain();
    if (active) {
      renderOverlay(active);
      return;
    }

    const detection = detectPnL();
    const threshold = -Math.abs(numberSetting("lossThresholdUsd", DEFAULT_SETTINGS.lossThresholdUsd));

    if (detection.bestLoss !== null && detection.bestLoss <= threshold) {
      await activateCooldown({
        loss: detection.bestLoss,
        reason: reason || "Loss threshold breached",
        snippet: detection.bestSnippet || "PnL loss detected on trading page."
      });
    }
  }

  function runSupportCheck() {
    const detection = detectPnL();
    const enabled = isEnabledForThisDomain();
    const threshold = -Math.abs(numberSetting("lossThresholdUsd", DEFAULT_SETTINGS.lossThresholdUsd));
    const matchedKeywords = [...new Set(detection.snippets.map((entry) => entry.keyword))];

    return {
      domain: window.location.hostname,
      enabledForDomain: enabled,
      readableTextFound: detection.readableTextFound,
      supported: detection.values.length > 0,
      threshold,
      matchedKeywords,
      detectedValues: detection.values.slice(0, 10),
      bestLoss: detection.bestLoss,
      snippets: detection.snippets.slice(0, 5),
      suggestions: buildSupportSuggestions({ enabled, detection })
    };
  }

  function buildSupportSuggestions({ enabled, detection }) {
    if (detection.values.length > 0) {
      return enabled
        ? ["PnL-like text was found. Use Test overlay before relying on it."]
        : ["PnL-like text was found, but this domain is not enabled yet."];
    }

    return detection.snippets.length > 0
      ? [
          "PnL keywords were found, but no nearby negative or positive money-like values were parsed.",
          "Open the portfolio, account, trade history, or realized PnL panel.",
          "Add the exact PnL label used by this exchange in Options."
        ]
        : [
            "No configured PnL keywords were found in readable page text.",
            "Open the portfolio, account, trade history, or realized PnL panel.",
            "Add the exact PnL label used by this exchange in Options.",
            "If the exchange renders PnL inside canvas/iframe/shadow DOM, this MVP may not detect it."
          ];
  }

  function detectPnL() {
    const text = getVisibleText();
    const keywords = normalizeKeywords(settings.keywords);
    const snippets = [];
    const values = [];

    for (const keyword of keywords) {
      const indexes = findAllIndexes(text.toLowerCase(), keyword.toLowerCase());
      for (const index of indexes.slice(0, 10)) {
        const start = Math.max(0, index - SUPPORT_SNIPPET_RADIUS);
        const end = Math.min(text.length, index + keyword.length + SUPPORT_SNIPPET_RADIUS);
        const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
        snippets.push({ keyword, snippet });

        const parsed = extractMoneyLikeValues(snippet);
        for (const value of parsed) {
          values.push({ value, keyword, snippet });
        }
      }
    }

    const negativeValues = values.map((entry) => entry.value).filter((value) => Number.isFinite(value) && value < 0);
    const bestLoss = negativeValues.length > 0 ? Math.min(...negativeValues) : null;
    const bestSnippet = bestLoss === null ? null : values.find((entry) => entry.value === bestLoss)?.snippet || null;

    return { readableTextFound: text.trim().length > 0, values, snippets, bestLoss, bestSnippet };
  }

  function getVisibleText() {
    const text = (document.body?.innerText || "").slice(0, MAX_SCAN_TEXT_CHARS);
    return text.replace(/\u2212/g, "-");
  }

  function normalizeKeywords(input) {
    const list = Array.isArray(input) ? input : String(input || "").split("\n");
    return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
  }

  function findAllIndexes(haystack, needle) {
    const indexes = [];
    if (!needle) return indexes;
    let start = 0;
    while (true) {
      const index = haystack.indexOf(needle, start);
      if (index === -1) break;
      indexes.push(index);
      start = index + needle.length;
    }
    return indexes;
  }

  function extractMoneyLikeValues(text) {
    const values = [];
    const normalized = String(text || "").replace(/\u2212/g, "-");
    // Capture common visible PnL formats without treating percentages as USD losses.
    const regex = /(?:^|[^\w.])((?:\(\s*)?[+-]?\s*(?:(?:USDC|USD)\s*)?\$?\s*[+-]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:[kmb])?\s*(?:USDC|USD)?\s*(?:\))?)(?![\w.%])/gi;
    let match;

    while ((match = regex.exec(normalized)) !== null) {
      const raw = match[1];
      const value = parseNumericValue(raw);
      if (Number.isFinite(value)) values.push(value);
    }

    return values;
  }

  function parseNumericValue(raw) {
    let s = String(raw || "").trim();
    const hasParens = /^\(\s*.*\s*\)$/.test(s);
    const hasMinus = s.includes("-");
    const suffixMatch = s.match(/([kmb])\s*(?:USDC|USD)?\s*\)?$/i);
    const multiplier = suffixMatch ? { k: 1000, m: 1000000, b: 1000000000 }[suffixMatch[1].toLowerCase()] : 1;
    const numberMatch = s.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
    if (!numberMatch) return NaN;

    let value = Number(numberMatch[0]) * multiplier;
    if (!Number.isFinite(value)) return NaN;
    if (hasParens || hasMinus) value = -Math.abs(value);
    return value;
  }

  async function activateCooldown({ loss, reason, snippet }) {
    const cooldownMinutes = Math.max(1, numberSetting("cooldownMinutes", DEFAULT_SETTINGS.cooldownMinutes));
    const now = Date.now();
    const state = {
      hostname: window.location.hostname,
      origin: window.location.origin,
      path: window.location.pathname,
      activeUntil: now + cooldownMinutes * 60 * 1000,
      activatedAt: now,
      detectedLoss: loss,
      reason,
      snippet
    };

    await chrome.storage.local.set({ [cooldownKey()]: state });
    renderOverlay(state);
  }

  async function rehydrateOverlayIfNeeded() {
    const active = await getActiveCooldownForCurrentDomain();
    if (active) renderOverlay(active);
  }

  async function getActiveCooldownForCurrentDomain() {
    const data = await chrome.storage.local.get(cooldownKey());
    const state = data[cooldownKey()];
    if (!state) return null;
    if (state.hostname !== window.location.hostname) return null;
    if (Number(state.activeUntil) <= Date.now()) {
      await clearCooldownForCurrentDomain();
      removeOverlay();
      return null;
    }
    return state;
  }

  function cooldownKey() {
    return `touchGrassCooldown:${window.location.hostname}`;
  }

  async function clearCooldownForCurrentDomain() {
    await chrome.storage.local.remove(cooldownKey());
  }

  function renderOverlay(state) {
    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      document.documentElement.appendChild(overlay);
    }

    overlay.innerHTML = `
      <div class="tgm-sky"></div>
      <div class="tgm-grass tgm-grass-back"></div>
      <div class="tgm-grass tgm-grass-mid"></div>
      <div class="tgm-grass tgm-grass-front"></div>
      <section class="tgm-card">
        <div class="tgm-kicker">Loss circuit breaker</div>
        <h1>Touch Grass Mode Activated</h1>
        <p class="tgm-main">Large realized loss detected. Step away before your next trade becomes revenge.</p>
        <div class="tgm-stats">
          <div><span>Detected loss</span><strong>${formatMoney(state.detectedLoss)}</strong></div>
          <div><span>Cooldown</span><strong id="tgm-countdown">--:--</strong></div>
        </div>
        <p class="tgm-snippet">${escapeHtml(state.snippet || "PnL loss detected on this trading page.")}</p>
        <button id="tgm-emergency-unlock" class="tgm-hidden" type="button">Emergency unlock</button>
        <p class="tgm-footer">Close the trading tab, breathe, journal the trade, then come back with a system.</p>
      </section>
    `;

    const unlockButton = overlay.querySelector("#tgm-emergency-unlock");
    unlockButton?.addEventListener("click", async () => {
      await clearCooldownForCurrentDomain();
      removeOverlay();
    });

    startCountdown(state);
  }

  function startCountdown(state) {
    if (countdownTimer) clearInterval(countdownTimer);

    const update = async () => {
      const remainingMs = Number(state.activeUntil) - Date.now();
      const countdown = document.getElementById("tgm-countdown");
      const unlockButton = document.getElementById("tgm-emergency-unlock");

      if (remainingMs <= 0) {
        await clearCooldownForCurrentDomain();
        removeOverlay();
        return;
      }

      if (countdown) countdown.textContent = formatDuration(remainingMs);

      const unlockDelayMs = Math.max(0, numberSetting("emergencyUnlockDelaySeconds", DEFAULT_SETTINGS.emergencyUnlockDelaySeconds)) * 1000;
      if (unlockButton && Date.now() - Number(state.activatedAt || 0) >= unlockDelayMs) {
        unlockButton.classList.remove("tgm-hidden");
      }
    };

    update();
    countdownTimer = setInterval(update, 1000);
  }

  function removeOverlay() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    document.getElementById(OVERLAY_ID)?.remove();
  }

  function formatMoney(value) {
    if (!Number.isFinite(Number(value))) return "Unknown";
    const sign = Number(value) < 0 ? "-" : "";
    return `${sign}$${Math.abs(Number(value)).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function escapeHtml(input) {
    return String(input || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
