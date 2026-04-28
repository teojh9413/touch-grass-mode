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
    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (response?.ok === false) throw new Error(response.error || "Unknown error");
    statusEl.textContent = formatResponse(response);
  } catch (error) {
    statusEl.textContent = `Could not talk to this page.\n\n${error.message}\n\nTry refreshing the trading page after loading the extension.`;
  }
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
    statusEl.textContent = `Enabled current site:\n${host}\n\nRefresh the page if support check does not respond.`;
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
