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

const fields = {
  lossThresholdUsd: document.getElementById("lossThresholdUsd"),
  cooldownMinutes: document.getElementById("cooldownMinutes"),
  emergencyUnlockDelaySeconds: document.getElementById("emergencyUnlockDelaySeconds"),
  enabledDomains: document.getElementById("enabledDomains"),
  keywords: document.getElementById("keywords")
};
const form = document.getElementById("optionsForm");
const saveStatus = document.getElementById("saveStatus");

load();
form.addEventListener("submit", save);

async function load() {
  const data = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  const settings = { ...DEFAULT_SETTINGS, ...data };
  fields.lossThresholdUsd.value = settings.lossThresholdUsd;
  fields.cooldownMinutes.value = settings.cooldownMinutes;
  fields.emergencyUnlockDelaySeconds.value = settings.emergencyUnlockDelaySeconds;
  fields.enabledDomains.value = arrayToLines(settings.enabledDomains);
  fields.keywords.value = arrayToLines(settings.keywords);
}

async function save(event) {
  event.preventDefault();
  const settings = {
    lossThresholdUsd: parseNumberField(fields.lossThresholdUsd.value, DEFAULT_SETTINGS.lossThresholdUsd, 1),
    cooldownMinutes: parseNumberField(fields.cooldownMinutes.value, DEFAULT_SETTINGS.cooldownMinutes, 1),
    emergencyUnlockDelaySeconds: parseNumberField(fields.emergencyUnlockDelaySeconds.value, DEFAULT_SETTINGS.emergencyUnlockDelaySeconds, 0),
    enabledDomains: linesToArray(fields.enabledDomains.value),
    keywords: linesToArray(fields.keywords.value)
  };
  await chrome.storage.sync.set(settings);
  saveStatus.textContent = "Saved.";
  setTimeout(() => (saveStatus.textContent = ""), 1600);
}

function linesToArray(value) {
  return String(value || "")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function arrayToLines(value) {
  return (Array.isArray(value) ? value : []).join("\n");
}

function parseNumberField(value, fallback, min) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, parsed) : fallback;
}
