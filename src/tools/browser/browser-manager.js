import puppeteer from "puppeteer";

/**
 * Manages a persistent headless browser session.
 * The browser and page persist across tool calls so the agent
 * can navigate, fill forms, and interact across multiple steps.
 */
export class BrowserManager {
  constructor() {
    this.browser = null;
    this.page = null;
  }

  async _ensureBrowser() {
    if (!this.browser || !this.browser.connected) {
      this.browser = await puppeteer.launch({
        headless: "shell",
        protocolTimeout: 60000,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1280, height: 800 });
    }
    return this.page;
  }

  async navigate(url) {
    const page = await this._ensureBrowser();
    // Try networkidle2 first, fall back to domcontentloaded if the page is slow
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    } catch (err) {
      if (err.name === "TimeoutError") {
        // Page is still loading but DOM is likely ready — continue with what we have
        console.error("  ⚠️ Browser: navigation timeout, continuing with partial load");
      } else {
        throw err;
      }
    }
    const title = await page.title();
    const screenshot = await this._safeScreenshot(page);
    return { title, url: page.url(), screenshot };
  }

  async screenshot() {
    const page = await this._ensureBrowser();
    const title = await page.title();
    const screenshot = await this._safeScreenshot(page);
    return { title, url: page.url(), screenshot };
  }

  async _safeScreenshot(page) {
    try {
      return await page.screenshot({ encoding: "base64", type: "png" });
    } catch {
      // If screenshot fails (e.g. protocol timeout), return null rather than crashing
      console.error("  ⚠️ Browser: screenshot capture failed, returning without image");
      return null;
    }
  }

  async click(selector) {
    const page = await this._ensureBrowser();

    // Try CSS selector first, then fall back to text content search
    try {
      await page.waitForSelector(selector, { timeout: 5000 });
      await page.click(selector);
    } catch {
      // Try finding by text content
      const handle = await page.evaluateHandle((text) => {
        const clickable = "a, button, input[type='submit'], input[type='button'], [role='button']";
        const elements = [...document.querySelectorAll(clickable)];
        return elements.find((e) => e.textContent.trim().toLowerCase().includes(text.toLowerCase())) || null;
      }, selector);

      const el = handle.asElement();
      if (!el) {
        throw new Error(`Could not find element matching "${selector}"`);
      }
      await el.click();
    }

    // Wait for any navigation or network activity to settle
    await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
    const screenshot = await this._safeScreenshot(page);
    return { url: page.url(), screenshot };
  }

  async type(selector, text, { pressEnter = false } = {}) {
    const page = await this._ensureBrowser();
    await page.waitForSelector(selector, { timeout: 5000 });
    await page.click(selector, { clickCount: 3 }); // select existing text
    await page.type(selector, text);
    if (pressEnter) {
      await page.keyboard.press("Enter");
      await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
    }
    const screenshot = await this._safeScreenshot(page);
    return { url: page.url(), screenshot };
  }

  async select(selector, value) {
    const page = await this._ensureBrowser();
    await page.waitForSelector(selector, { timeout: 5000 });
    await page.select(selector, value);
    const screenshot = await this._safeScreenshot(page);
    return { url: page.url(), screenshot };
  }

  async getText(selector) {
    const page = await this._ensureBrowser();
    if (selector) {
      await page.waitForSelector(selector, { timeout: 5000 });
      return page.$eval(selector, (el) => el.textContent.trim());
    }
    // Return full page text, truncated
    const text = await page.evaluate(() => document.body.innerText);
    return text.substring(0, 50000);
  }

  async evaluate(code) {
    const page = await this._ensureBrowser();
    const result = await page.evaluate(code);
    return result;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }
}
