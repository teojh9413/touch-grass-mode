const DEFAULT_SETTINGS = {
  enabledDomains: ["app.hyperliquid.xyz"],
  lossThresholdUsd: 500,
  cooldownMinutes: 15,
  keywords: [
    "Realized PnL",
    "Realized PNL",
    "Daily PnL",
    "Daily PNL",
    "Today's PnL",
    "Portfolio PnL",
    "Account PnL",
    "PnL",
    "PNL"
  ],
  emergencyUnlockDelaySeconds: 60
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  const patch = {};

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (existing[key] === undefined) patch[key] = value;
  }

  if (Object.keys(patch).length > 0) {
    await chrome.storage.sync.set(patch);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "GET_DEFAULT_SETTINGS") {
    sendResponse(DEFAULT_SETTINGS);
    return true;
  }

  return false;
});
