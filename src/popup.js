const statusEl = document.getElementById("status");
const buttons = {
  enableSite: document.getElementById("enableSite"),
  checkSupport: document.getElementById("checkSupport"),
  testOverlay: document.getElementById("testOverlay"),
  clearOverlay: document.getElementById("clearOverlay"),
  openOptions: document.getElementById("openOptions")
};

buttons.enableSite.addEventListener("click", enableCurrentSite);
buttons.checkSupport.addEventListener("click", checkSupport);
buttons.testOverlay.addEventListener("click", () => sendToActiveTab({ type: "TRIGGER_TEST_OVERLAY" }));
buttons.clearOverlay.addEventListener("click", () => sendToActiveTab({ type: "CLEAR_OVERLAY" }));
buttons.openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new Error("No active tab found.");
  return tab;
}

async function sendToActiveTab(message) {
  try {
    const tab = await getActiveTab();
    const response = await sendMessageWithInjection(tab, message);
    if (response?.ok === false) throw new Error(response.error || "Unknown error");
    statusEl.textContent = formatResponse(response);
  } catch (error) {
    statusEl.textContent = `Could not talk to this page.\n\n${error.message}\n\nRefresh the trading tab if it was open before the extension was installed or reloaded.`;
  }
}

async function sendMessageWithInjection(tab, message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    if (!isMissingContentScriptError(error)) throw error;
    await injectContentScript(tab);
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

function isMissingContentScriptError(error) {
  return /receiving end does not exist|could not establish connection/i.test(error?.message || String(error || ""));
}

async function injectContentScript(tab) {
  const url = new URL(tab.url);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("This page type does not allow extension content scripts.");
  }

  await chrome.scripting.insertCSS({
    target: { tabId: tab.id },
    files: ["src/overlay.css"]
  });

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["src/content.js"]
  });
}

async function enableCurrentSite() {
  try {
    const tab = await getActiveTab();
    const url = new URL(tab.url);
    const host = url.hostname;
    const data = await chrome.storage.sync.get(["enabledDomains"]);
    const enabledDomains = Array.isArray(data.enabledDomains) ? data.enabledDomains : [];
    if (!enabledDomains.includes(host)) {
      enabledDomains.push(host);
      await chrome.storage.sync.set({ enabledDomains });
    }
    statusEl.textContent = `Enabled current site:\n${host}\n\nNow run Check support.`;
  } catch (error) {
    statusEl.textContent = error.message;
  }
}

async function checkSupport() {
  await sendToActiveTab({ type: "SUPPORT_CHECK" });
}

function formatResponse(response) {
  if (!response) return "Done.";
  if (response.supported !== undefined) {
    const matchedKeywords = response.matchedKeywords?.length
      ? response.matchedKeywords.join(", ")
      : "None";

    const values = (response.detectedValues || [])
      .slice(0, 5)
      .map((entry) => `- ${formatMoney(entry.value)} near "${entry.keyword}"`)
      .join("\n") || "No PnL-like values found.";

    const snippets = (response.snippets || [])
      .slice(0, 3)
      .map((entry) => `"${entry.snippet}"`)
      .join("\n\n");

    return [
      `Domain: ${response.domain}`,
      `Enabled: ${response.enabledForDomain ? "Yes" : "No"}`,
      `Readable page text: ${response.readableTextFound ? "Yes" : "No"}`,
      `Support detected: ${response.supported ? "Yes" : "No"}`,
      `Threshold: ${formatMoney(response.threshold)}`,
      `Best loss: ${response.bestLoss === null ? "None" : formatMoney(response.bestLoss)}`,
      `Matched keywords: ${matchedKeywords}`,
      "",
      "Detected values:",
      values,
      snippets ? `\nSnippets:\n${snippets}` : "",
      response.suggestions?.length ? `\nSuggestions:\n${response.suggestions.join("\n")}` : ""
    ].join("\n");
  }
  return "Done.";
}

function formatMoney(value) {
  if (!Number.isFinite(Number(value))) return "None";
  const sign = Number(value) < 0 ? "-" : "";
  return `${sign}$${Math.abs(Number(value)).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
