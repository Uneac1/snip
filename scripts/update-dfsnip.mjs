import { createHash } from "node:crypto";
import { chromium } from "playwright";

const SOURCE_URL = "https://sniweb.danfeng.eu.org/";
const TARGET_URL = "https://misub.y130.icu/";
const TZ = "Asia/Shanghai";
const MISUB_PASSWORD = process.env.MISUB_PASSWORD;

function requireMatch(input, regex, message) {
  const match = input.match(regex);
  if (!match) {
    throw new Error(message);
  }
  return match;
}

function parseDomains(scriptBlock) {
  const [, rawDomains] = requireMatch(
    scriptBlock,
    /const\s+domains\s*=\s*\[(.*?)\];/s,
    "Could not find domains array in source page."
  );

  const domains = Array.from(rawDomains.matchAll(/'([^']+)'/g), (match) => match[1]);
  if (domains.length === 0) {
    throw new Error("Source page domains array was empty.");
  }

  return domains;
}

function parseAuthToken(scriptBlock) {
  const [, authToken] = requireMatch(
    scriptBlock,
    /const\s+authToken\s*=\s*'([^']+)';/,
    "Could not find auth token in source page."
  );

  return authToken;
}

function shanghaiDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function seededHex(seed) {
  return createHash("sha256").update(seed).digest("hex");
}

function buildSubdomain(seed) {
  const hex = seededHex(seed);
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const lettersDigits = "abcdefghijklmnopqrstuvwxyz0123456789";

  let label = letters[parseInt(hex.slice(0, 2), 16) % letters.length];
  for (let i = 2; i < 22; i += 2) {
    label += lettersDigits[parseInt(hex.slice(i, i + 2), 16) % lettersDigits.length];
  }
  label += lettersDigits[parseInt(hex.slice(22, 24), 16) % lettersDigits.length];
  return label;
}

function pickDomain(domains, seed) {
  const hex = seededHex(seed);
  const index = parseInt(hex.slice(0, 8), 16) % domains.length;
  return domains[index];
}

async function fetchSourceHtml() {
  const response = await fetch(SOURCE_URL, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; dfsnip-sync/1.0)"
    }
  });

  if (!response.ok) {
    throw new Error(`Source page request failed: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loginMisub(page) {
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 120000 });

  const passwordField = page.locator("input[type='password'], input").first();
  await passwordField.waitFor({ state: "visible", timeout: 30000 });
  await passwordField.fill(MISUB_PASSWORD);

  const submitCandidates = [
    page.getByRole("button", { name: /confirm|submit|login|enter|unlock|ok|save/i }).first(),
    page.locator("button").first()
  ];

  let clicked = false;
  for (const candidate of submitCandidates) {
    if (clicked) break;
    try {
      await candidate.click({ timeout: 5000 });
      clicked = true;
    } catch {
      // Try the next candidate.
    }
  }

  if (!clicked) {
    throw new Error("Could not find a login button on Misub.");
  }

  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
}

async function tagDfsniCard(page) {
  const title = page.getByText(/^Dfsni$/).first();
  await title.waitFor({ state: "visible", timeout: 30000 });

  const tagged = await title.evaluate((titleNode) => {
    document.querySelectorAll("[data-codex-dfsni-card='true']").forEach((el) => {
      el.removeAttribute("data-codex-dfsni-card");
    });

    const card = titleNode.closest(".group");
    if (!card) return false;
    card.setAttribute("data-codex-dfsni-card", "true");
    return true;
  });

  if (!tagged) {
    throw new Error("Could not locate the Dfsni card after login.");
  }
}

async function openEditor(page) {
  const card = page.locator("[data-codex-dfsni-card='true']").first();
  await card.waitFor({ state: "visible", timeout: 30000 });

  const editCandidates = [
    card.locator("button").first(),
    card.getByRole("button", { name: /edit/i }).first(),
    card.locator("svg").first()
  ];

  for (const candidate of editCandidates) {
    try {
      await candidate.click({ timeout: 5000 });
      await page.waitForTimeout(1500);
      return;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error("Could not open the Dfsni edit dialog.");
}

async function replaceSubscriptionUrl(page, url) {
  const modalTitle = page.getByText("编辑订阅").last();
  await modalTitle.waitFor({ state: "visible", timeout: 30000 });

  const modal = page.locator(".fixed.inset-0").last();
  const urlField = modal.locator("input[type='text']").nth(1);
  await urlField.waitFor({ state: "visible", timeout: 30000 });
  await urlField.fill(url);

  const confirmCandidates = [
    modal.locator("button").last(),
    modal.getByRole("button", { name: /confirm|submit|save|update|ok/i }).last(),
    modal.locator("button").last()
  ];

  for (const candidate of confirmCandidates) {
    try {
      await candidate.click({ timeout: 5000 });
      return;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error("Could not confirm the Dfsni update.");
}

async function verifyUpdate(page, url) {
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await tagDfsniCard(page);
  const card = page.locator("[data-codex-dfsni-card='true']").first();
  await expectCardInputValue(card, url);
}

async function expectCardInputValue(card, expectedUrl) {
  const input = card.locator("input[type='text']").first();
  await input.waitFor({ state: "visible", timeout: 30000 });
  const actualValue = await input.inputValue();
  if (actualValue !== expectedUrl) {
    throw new Error(`Dfsni link did not update as expected. Current value: ${actualValue}`);
  }
}

async function main() {
  if (!MISUB_PASSWORD) {
    throw new Error("MISUB_PASSWORD is required. Add it as a GitHub Actions secret.");
  }

  const html = await fetchSourceHtml();
  const scriptBlock = requireMatch(
    html,
    /<script>([\s\S]*?const\s+domains\s*=\s*\[[\s\S]*?)<\/script>/i,
    "Could not find source page script block."
  )[1];

  const domains = parseDomains(scriptBlock);
  const authToken = parseAuthToken(scriptBlock);
  const dateKey = shanghaiDateKey();
  const domain = pickDomain(domains, `domain:${dateKey}:${authToken}`);
  const randomSub = buildSubdomain(`subdomain:${dateKey}:${authToken}:${domain}`);

  const url =
    `https://${randomSub}.chinat.eu.org/sub` +
    `?uuid=${encodeURIComponent(authToken)}` +
    `&host=${encodeURIComponent(domain)}` +
    `&path=${encodeURIComponent("/danfeng?ed=2560&ech=1")}`;

  console.log(`Generated source link for ${dateKey} (${TZ}).`);
  console.log(url);

  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 960 }
    });

    await loginMisub(page);
    await tagDfsniCard(page);
    await openEditor(page);
    await replaceSubscriptionUrl(page, url);
    await verifyUpdate(page, url);

    console.log("Successfully updated Dfsni in Misub.");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
