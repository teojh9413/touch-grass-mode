#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
let failed = false;

function fail(message) {
  failed = true;
  console.error(`FAIL ${message}`);
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function assertExists(relativePath) {
  if (!fs.existsSync(path.join(root, relativePath))) {
    fail(`missing ${relativePath}`);
    return;
  }
  pass(`found ${relativePath}`);
}

function checkSyntax(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  try {
    new vm.Script(source, { filename: relativePath });
    pass(`syntax ${relativePath}`);
  } catch (error) {
    fail(`syntax ${relativePath}: ${error.message}`);
  }
}

function extractDefaultSettings(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  const start = source.indexOf("const DEFAULT_SETTINGS = ");
  if (start === -1) {
    fail(`DEFAULT_SETTINGS missing in ${relativePath}`);
    return null;
  }

  const objectStart = source.indexOf("{", start);
  const objectEnd = source.indexOf("};", objectStart);
  const literal = source.slice(objectStart, objectEnd + 1);

  const match = objectStart !== -1 && objectEnd !== -1;
  if (!match) {
    fail(`DEFAULT_SETTINGS missing in ${relativePath}`);
    return null;
  }

  try {
    return vm.runInNewContext(`(${literal})`);
  } catch (error) {
    fail(`DEFAULT_SETTINGS parse failed in ${relativePath}: ${error.message}`);
    return null;
  }
}

function parseMoneySamples() {
  const samples = [
    ["Realized PnL -$720.55", [-720.55]],
    ["Daily PnL ($1,250.00)", [-1250]],
    ["PnL USD -500", [-500]],
    ["PNL $-500", [-500]],
    ["Account PnL -1.2k USDC", [-1200]],
    ["PnL -5.2%", []],
    ["PnL +$300", [300]]
  ];

  for (const [input, expected] of samples) {
    const actual = extractMoneyLikeValues(input);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`money parse ${input}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    } else {
      pass(`money parse ${input}`);
    }
  }
}

function extractMoneyLikeValues(text) {
  const values = [];
  const normalized = String(text || "").replace(/\u2212/g, "-");
  const regex = /(?:^|[^\w.])((?:\(\s*)?[+-]?\s*(?:(?:USDC|USD)\s*)?\$?\s*[+-]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:[kmb])?\s*(?:USDC|USD)?\s*(?:\))?)(?![\w.%])/gi;
  let match;

  while ((match = regex.exec(normalized)) !== null) {
    const value = parseNumericValue(match[1]);
    if (Number.isFinite(value)) values.push(value);
  }

  return values;
}

function parseNumericValue(raw) {
  const value = String(raw || "").trim();
  const hasParens = /^\(\s*.*\s*\)$/.test(value);
  const hasMinus = value.includes("-");
  const suffixMatch = value.match(/([kmb])\s*(?:USDC|USD)?\s*\)?$/i);
  const multiplier = suffixMatch ? { k: 1000, m: 1000000, b: 1000000000 }[suffixMatch[1].toLowerCase()] : 1;
  const numberMatch = value.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!numberMatch) return NaN;

  let parsed = Number(numberMatch[0]) * multiplier;
  if (!Number.isFinite(parsed)) return NaN;
  if (hasParens || hasMinus) parsed = -Math.abs(parsed);
  return parsed;
}

const manifest = readJson("manifest.json");
const requiredPermissions = ["storage", "activeTab", "tabs", "scripting"];

for (const permission of requiredPermissions) {
  if (!manifest.permissions?.includes(permission)) {
    fail(`manifest permission ${permission}`);
  } else {
    pass(`manifest permission ${permission}`);
  }
}

[
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_page,
  ...Object.values(manifest.icons || {}),
  ...(manifest.content_scripts || []).flatMap((script) => [...(script.js || []), ...(script.css || [])])
].filter(Boolean).forEach(assertExists);

["src/background.js", "src/content.js", "src/options.js", "src/popup.js"].forEach(checkSyntax);

const backgroundSettings = extractDefaultSettings("src/background.js");
const contentSettings = extractDefaultSettings("src/content.js");
const optionsSettings = extractDefaultSettings("src/options.js");

if (
  JSON.stringify(backgroundSettings) === JSON.stringify(contentSettings) &&
  JSON.stringify(backgroundSettings) === JSON.stringify(optionsSettings)
) {
  pass("default settings are consistent");
} else {
  fail("default settings differ between background/content/options");
}

parseMoneySamples();

if (failed) {
  process.exit(1);
}

console.log("Touch Grass Mode smoke test passed.");
