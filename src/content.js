(() => {
  if (globalThis.__touchGrassModeContentLoaded) return;
  globalThis.__touchGrassModeContentLoaded = true;

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
  let grassAnimationFrame = null;
  let grassResizeHandler = null;
  let observer = null;
  let extensionContextInvalidated = false;

  init();

  async function init() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      handleMessage(message).then(sendResponse).catch((error) => {
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
      return true;
    });

    settings = await loadSettings();
    if (extensionContextInvalidated) return;

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      for (const key of Object.keys(changes)) {
        settings[key] = changes[key].newValue;
      }
      syncScannerState("settings_changed");
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
      if (handleExtensionContextError(error)) return { ...DEFAULT_SETTINGS };
      console.warn("Touch Grass Mode: failed to load settings", error);
      return { ...DEFAULT_SETTINGS };
    }
  }

  function handleExtensionContextError(error) {
    if (!isExtensionContextInvalidated(error)) return false;
    shutdownInvalidatedContext();
    return true;
  }

  function isExtensionContextInvalidated(error) {
    if (extensionContextInvalidated) return true;
    const message = error?.message || String(error || "");
    let runtimeMissing = false;
    try {
      runtimeMissing = typeof chrome === "undefined" || !chrome.runtime?.id;
    } catch (_) {
      runtimeMissing = true;
    }
    return runtimeMissing || /extension context invalidated/i.test(message);
  }

  function shutdownInvalidatedContext() {
    extensionContextInvalidated = true;
    stopObserver();
    removeOverlay();
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
    if (extensionContextInvalidated) return;
    const now = Date.now();
    if (now - lastScanAt < THROTTLE_MS) return;
    lastScanAt = now;
    checkForLoss(reason).catch((error) => {
      if (handleExtensionContextError(error)) return;
      console.warn("Touch Grass Mode: loss check failed", error);
    });
  }

  async function checkForLoss(reason) {
    if (!isEnabledForThisDomain()) return;

    const active = await getActiveCooldownForCurrentDomain();
    if (active) {
      if (!document.getElementById(OVERLAY_ID)) renderOverlay(active);
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
      <canvas id="tgm-grass-canvas" aria-hidden="true"></canvas>
      <div class="tgm-ground-mist"></div>
      <div class="tgm-vignette"></div>
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

    startGrassCanvas(overlay.querySelector("#tgm-grass-canvas"));
    startCountdown(state);
  }

  function startGrassCanvas(canvas) {
    stopGrassCanvas();
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let blades = [];
    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      blades = createGrassBlades(width, height);
    };

    const draw = (timestamp) => {
      ctx.clearRect(0, 0, width, height);
      drawGrassField(ctx, blades, width, height, timestamp / 1000);
      grassAnimationFrame = requestAnimationFrame(draw);
    };

    grassResizeHandler = resize;
    window.addEventListener("resize", grassResizeHandler, { passive: true });
    resize();
    grassAnimationFrame = requestAnimationFrame(draw);
  }

  function stopGrassCanvas() {
    if (grassAnimationFrame) cancelAnimationFrame(grassAnimationFrame);
    grassAnimationFrame = null;

    if (grassResizeHandler) {
      window.removeEventListener("resize", grassResizeHandler);
      grassResizeHandler = null;
    }
  }

  function createGrassBlades(width, height) {
    const random = seededRandom(Math.floor(width * 31 + height * 17));
    const density = Math.min(1450, Math.max(520, Math.floor((width * height) / 1250)));
    const blades = [];

    for (let i = 0; i < density; i += 1) {
      const depth = Math.pow(random(), 0.62);
      const baseY = height * (0.5 + depth * 0.56);
      const layer = depth < 0.36 ? 0 : depth < 0.72 ? 1 : 2;
      const length = interpolate(28, 185, depth) * interpolate(0.82, 1.22, random());
      const widthPx = interpolate(0.75, 3.4, depth) * interpolate(0.75, 1.25, random());
      const hue = interpolate(78, 112, random()) - layer * 2;
      const saturation = interpolate(42, 78, random());
      const lightness = interpolate(15, 43, depth) + interpolate(-5, 7, random());

      blades.push({
        x: random() * width,
        y: Math.min(height + length * 0.25, baseY + random() * height * 0.05),
        length,
        width: widthPx,
        bend: interpolate(-0.32, 0.34, random()) * length,
        phase: random() * Math.PI * 2,
        speed: interpolate(0.75, 1.65, random()),
        wind: interpolate(0.09, 0.34, random()) * interpolate(0.7, 1.3, depth),
        color: `hsla(${hue}, ${saturation}%, ${lightness}%, ${interpolate(0.62, 0.96, depth)})`,
        highlight: `hsla(${hue + 9}, ${Math.min(92, saturation + 12)}%, ${Math.min(68, lightness + 18)}%, ${interpolate(0.12, 0.34, depth)})`,
        layer
      });
    }

    return blades.sort((a, b) => a.layer - b.layer || a.y - b.y);
  }

  function drawGrassField(ctx, blades, width, height, time) {
    const gust = Math.sin(time * 0.34) * 0.45 + Math.sin(time * 0.11) * 0.32;
    const horizon = height * 0.5;

    const ground = ctx.createLinearGradient(0, horizon, 0, height);
    ground.addColorStop(0, "rgba(7, 42, 20, 0.04)");
    ground.addColorStop(0.44, "rgba(8, 54, 20, 0.24)");
    ground.addColorStop(1, "rgba(0, 12, 4, 0.84)");
    ctx.fillStyle = ground;
    ctx.fillRect(0, horizon, width, height - horizon);

    for (const blade of blades) {
      const sway = (Math.sin(time * blade.speed + blade.phase) + gust) * blade.wind * blade.length;
      const tipX = blade.x + blade.bend + sway;
      const tipY = blade.y - blade.length;
      const controlX = blade.x + blade.bend * 0.42 + sway * 0.72;
      const controlY = blade.y - blade.length * 0.56;

      ctx.beginPath();
      ctx.moveTo(blade.x, blade.y);
      ctx.quadraticCurveTo(controlX, controlY, tipX, tipY);
      ctx.lineWidth = blade.width;
      ctx.strokeStyle = blade.color;
      ctx.lineCap = "round";
      ctx.stroke();

      if (blade.layer === 2 && blade.width > 1.7) {
        ctx.beginPath();
        ctx.moveTo(blade.x + blade.width * 0.2, blade.y - blade.length * 0.12);
        ctx.quadraticCurveTo(controlX + 1.5, controlY + blade.length * 0.08, tipX + 0.5, tipY + blade.length * 0.08);
        ctx.lineWidth = Math.max(0.45, blade.width * 0.25);
        ctx.strokeStyle = blade.highlight;
        ctx.stroke();
      }
    }

    drawDew(ctx, width, height, time);
  }

  function drawDew(ctx, width, height, time) {
    const random = seededRandom(width * 13 + height * 29);
    const count = Math.min(90, Math.floor(width / 12));
    ctx.fillStyle = `rgba(224, 255, 206, ${0.18 + Math.sin(time * 1.2) * 0.04})`;

    for (let i = 0; i < count; i += 1) {
      const x = random() * width;
      const y = height * interpolate(0.68, 0.95, random());
      const radius = interpolate(0.55, 1.5, random());
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function interpolate(min, max, amount) {
    return min + (max - min) * amount;
  }

  function seededRandom(seed) {
    let value = seed || 1;
    return () => {
      value = (value * 1664525 + 1013904223) >>> 0;
      return value / 4294967296;
    };
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

    runCountdownUpdate(update);
    countdownTimer = setInterval(() => runCountdownUpdate(update), 1000);
  }

  function runCountdownUpdate(update) {
    update().catch((error) => {
      if (handleExtensionContextError(error)) return;
      console.warn("Touch Grass Mode: countdown update failed", error);
    });
  }

  function removeOverlay() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    stopGrassCanvas();
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
