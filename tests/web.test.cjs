// Development-only browser checks. Run make html before these tests.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const http = require("node:http");
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const root = path.resolve(__dirname, "..");
const storageKey = "what-the-food.locations.v1";
function snapshot(day = "2026-10-27", partial = false) {
  const item = (name, price, cafe, index) => ({
    id: `${cafe}.buy-ondemand.com::site::profile::vendor::menu::Entrees::${index}`,
    location: cafe === "cafe2" ? "Cafe 2" : "Cafe 10", vendor: "Caf\u00e9 Vendor", menu: "Tuesday",
    category: "Entrees", name, description: "Hot lunch", price, currency: "USD",
    orderingURL: `https://${cafe}.buy-ondemand.com/?displayProfileId=profile`,
    vendorOpeningWindow: { start: "2026-10-27T18:00:00Z", end: "2026-10-27T21:00:00Z" },
    ...(name === "Soup" ? {} : { orderingCategoryPath: name === "Fish taco" ? ["0", "1"] : ["4"] }),
  });
  return {
    schemaVersion: 1, campusDay: day, timeZone: "America/Los_Angeles",
    generatedAt: `${day}T17:00:00Z`, complete: !partial,
    locations: [
      { id: "cafe2.buy-ondemand.com", name: "Cafe 2", status: "ok", notices: [], items: [
        item("Soup", "2.50", "cafe2", 0), item('<img src=x onerror="window.injected=true">', "12.00", "cafe2", 1),
        ...Array.from({ length: 205 }, (_, i) => item(`Dish ${i}`, "6.00", "cafe2", i + 2)),
      ] },
      { id: "cafe10.buy-ondemand.com", name: "Cafe 10", status: "ok", notices: ["One menu unavailable"], items: [
        item("Fish taco", "10.00", "cafe10", 0),
      ] },
      { id: "unlinked", name: "Unlinked", status: "no_ordering_url", notices: [], items: [] },
      ...(partial ? [{ id: "failed", name: "Failed", status: "error", error: "HTTP 403", notices: [], items: [] }] : []),
    ],
  };
}

async function site(data) {
  await fs.mkdir(path.join(root, ".tmp"), { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, ".tmp", "web-test-"));
  await fs.copyFile(path.join(root, "web", "index.html"), path.join(directory, "index.html"));
  if (data) await fs.writeFile(path.join(directory, "menus.js"), `const menuData = ${JSON.stringify(data)};\n`);
  return { directory, url: pathToFileURL(path.join(directory, "index.html")).href };
}

for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  test(`${name}: centered full icon stays visible until menu data loads`, async () => {
    const fixture = await site(snapshot());
    const html = await fs.readFile(path.join(fixture.directory, "index.html"));
    const menus = await fs.readFile(path.join(fixture.directory, "menus.js"));
    let releaseMenus;
    const ready = new Promise(resolve => { releaseMenus = resolve; });
    const server = http.createServer(async (request, response) => {
      if (request.url === "/menus.js") {
        await ready;
        response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(menus);
      } else if (request.url === "/") {
        response.writeHead(200, { "Content-Type": "text/html" }); response.end(html);
      } else { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await engine.launch({
      headless: true,
      ...(name === "webkit" && process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE } : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
      await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "commit" });
      await page.locator("#loading-screen svg").waitFor({ state: "visible" });
      for (const viewport of [{ width: 375, height: 667 }, { width: 1200, height: 800 }]) {
        await page.setViewportSize(viewport);
        const artwork = await page.locator("#loading-screen svg").boundingBox();
        assert(Math.abs(artwork.width - artwork.height) < 1, "The complete square icon is not stretched");
        assert(Math.abs(artwork.x + artwork.width / 2 - viewport.width / 2) < 1);
        assert(Math.abs(artwork.y + artwork.height / 2 - viewport.height / 2) < 1);
        assert(artwork.width >= Math.min(viewport.width, viewport.height) * 0.89);
        assert.equal(await page.locator("tbody tr").count(), 0);
      }
      releaseMenus();
      await page.waitForLoadState("load");
      assert.equal(await page.locator("#loading-screen").isVisible(), false);
      assert.match(await page.locator("#summary").innerText(), /208 matches/);
      const noScript = await browser.newPage({ javaScriptEnabled: false });
      await noScript.goto(`http://127.0.0.1:${server.address().port}/`);
      assert.equal(await noScript.locator("#loading-screen").isVisible(), false);
      assert.equal(await noScript.locator("noscript p").isVisible(), true);
    } finally {
      releaseMenus();
      await browser.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await fs.rm(fixture.directory, { recursive: true });
    }
  });

  test(`${name}: quoted phrases match within fields and combine with AND`, async () => {
    const data = snapshot();
    const first = data.locations[0].items[0], second = data.locations[1].items[0];
    data.locations[0].name = "Food Hall 4";
    data.locations[0].items = [{ ...first, location: "Food Hall 4", price: "6.00" }];
    data.locations[1].name = "Food Hall 6";
    data.locations[1].items = [{ ...second, location: "Food Hall 6", name: "Chicken taco" }];
    const fixture = await site(data);
    const browser = await engine.launch({
      headless: true,
      ...(name === "webkit" && process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE } : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      await page.goto(fixture.url);
      await page.locator("#sort-field").selectOption("price");
      await page.locator("#sort-direction").click();
      for (const [query, count] of [
        ["food hall 6", 2],
        ['"FOOD  HALL 6"', 1],
        ['"Food hall 6" chicken cafe', 1],
        ['"Food hall 6" soup', 0],
        ['"entrees chicken"', 0],
        ['"Food hall 6" "hot lunch"', 1],
        ['"Food hall 6', 1],
        ['\u201cFood hall 6\u201d chicken', 1],
        ['""', 2],
        ["", 2],
      ]) {
        await page.locator("#query").fill(query);
        assert.equal(await page.locator("tbody tr").count(), count, query);
        if (count === 1) assert.equal(await page.locator("tbody tr td").first().innerText(), "Food Hall 6");
      }
      assert.equal(await page.locator("#sort-field").inputValue(), "price");
      assert.equal(await page.locator('th[data-field="price"]').getAttribute("aria-sort"), "descending");
      assert.equal(await page.locator("tbody tr").first().locator("td").nth(4).innerText(), "$10.00");
    } finally { await browser.close(); await fs.rm(fixture.directory, { recursive: true }); }
  });

  test(`${name}: direct-file menus, search, numeric/natural sorting, dialogs, locations`, async () => {
    const fixture = await site(snapshot());
    const browser = await engine.launch({
      headless: true,
      ...(name === "webkit" && process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE } : {}),
    });
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      const page = await context.newPage();
      const errors = [], requests = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => requests.push(request.url()));
      await page.clock.install({ time: new Date("2026-10-27T19:00:00Z") });
      await page.goto(fixture.url);
      assert.match(await page.locator("#summary").innerText(), /208 matches/);
      assert.equal(await page.locator("#data-warning").isVisible(), false);
      assert.equal(await page.locator("tbody tr").first().locator("td").first().innerText(), "Cafe 2");
      await page.locator("#query").fill("cafe vendor fish 10");
      assert.equal(await page.locator("tbody tr").count(), 1);
      await page.getByRole("button", { name: "Fish taco", exact: true }).click();
      await page.locator("#detail-dialog").waitFor({ state: "visible" });
      assert.match(await page.locator("#ordering-link").getAttribute("href"), /\/menu\/site\/profile\/vendor\/0\/1$/);
      assert.match(await page.locator("#pickup-link").getAttribute("href"), /\?displayProfileId=profile$/);
      await page.clock.setSystemTime(new Date("2026-10-27T21:00:00Z"));
      await page.clock.runFor(1000);
      assert.match(await page.locator("#ordering-link").innerText(), /Choose Pickup Time/);
      assert.match(await page.locator("#ordering-link").getAttribute("href"), /\/\?displayProfileId=profile$/);
      await page.locator("#detail-dialog [data-close]").click();
      assert.equal(await page.locator("#query").inputValue(), "cafe vendor fish 10");
      await page.locator("#query").fill("");
      await page.locator("#sort-field").selectOption("price");
      assert.equal(await page.locator("tbody tr").first().locator("td").nth(4).innerText(), "$2.50");
      await page.locator("#sort-direction").click();
      assert.equal(await page.locator("tbody tr").first().locator("td").nth(4).innerText(), "$12.00");
      assert.equal(await page.locator("tbody img").count(), 0);
      assert.equal(await page.evaluate(() => window.injected), undefined);
      await page.clock.setSystemTime(new Date("2026-10-27T19:00:00Z"));
      await page.locator("tbody tr").first().getByRole("button").click();
      assert.match(await page.locator("#ordering-link").getAttribute("href"), /\/menu\/site\/profile\/vendor\/4$/);
      await page.locator("#detail-dialog [data-close]").click();
      await page.locator("#query").fill("fish");
      await page.locator("#about-button").click();
      await page.locator("#about-locations-button").click();
      assert.equal(await page.locator("#about-dialog").isVisible(), false);
      assert.equal(await page.locator("#locations-dialog").isVisible(), true);
      await page.getByRole("switch", { name: "Cafe 10", exact: true }).uncheck();
      await page.locator("#locations-dialog [data-close]").click();
      assert.match(await page.locator("#summary").innerText(), /0 matches/);
      const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
      assert.deepEqual(saved, ["cafe10.buy-ondemand.com"]);
      assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), [storageKey]);
      await page.reload();
      assert.equal(await page.locator("#query").inputValue(), "");
      assert.equal(await page.locator("#sort-field").inputValue(), "location");
      assert.match(await page.locator("#summary").innerText(), /207 matches/);
      await page.locator("#locations-button").click();
      await page.getByRole("switch", { name: "Cafe 2", exact: true }).uncheck();
      await page.locator("#locations-dialog [data-close]").click();
      assert.equal(await page.locator("#empty-title").innerText(), "No locations enabled");
      await page.locator("#empty-locations").click();
      await page.getByRole("switch", { name: "Cafe 2", exact: true }).check();
      await page.locator("#locations-dialog [data-close]").click();
      await page.setViewportSize({ width: 375, height: 667 });
      assert.equal(await page.locator("thead").isVisible(), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator("#query").fill("soup");
      await page.getByRole("button", { name: "Soup", exact: true }).click();
      assert.equal(await page.locator("#detail-price").innerText(), "$2.50");
      assert.match(await page.locator("#ordering-link").getAttribute("href"), /\/menu\/site\/profile\/vendor$/);
      await page.locator("#detail-dialog [data-close]").click();
      await page.clock.setSystemTime(new Date("2026-10-28T07:01:00Z"));
      await page.clock.runFor(1000);
      assert.match(await page.locator("#data-warning").innerText(), /not today/);
      assert.equal(errors.length, 0, errors.join("\n"));
      assert(requests.every(url => url.startsWith("file:")), "Page must not make network requests");
    } finally { await browser.close(); await fs.rm(fixture.directory, { recursive: true }); }
  });

  test(`${name}: search keeps live results in a browser-resized phone viewport`, async () => {
    const fixture = await site(snapshot());
    const browser = await engine.launch({
      headless: true,
      ...(name === "webkit" && process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE } : {}),
    });
    try {
      const context = await browser.newContext({
        viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true,
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.clock.install({ time: new Date("2026-10-27T19:00:00Z") });
      await page.goto(fixture.url);
      assert.equal(await page.locator(".sort-controls").isVisible(), false);
      assert.equal(await page.locator("#compact-sort").isVisible(), true);
      const widths = await page.evaluate(() => ["compact-sort", "about-button", "locations-button"]
        .map(id => document.getElementById(id).getBoundingClientRect().width));
      assert.deepEqual(widths, [44, 44, 44]);
      const searchWidth = await page.locator(".search").evaluate(element => element.getBoundingClientRect().width);
      assert(searchWidth > 330, "Search uses the available footer width");
      await page.locator("#compact-sort-order").selectOption("price:desc");
      assert.equal(await page.locator("tbody tr").first().locator("td").nth(4).innerText(), "$12.00");
      await page.locator("#compact-sort-order").selectOption("location:desc");
      assert.equal(await page.locator("tbody tr").first().locator("td").first().innerText(), "Cafe 10");
      await page.locator("#compact-sort-order").selectOption("price:asc");
      assert.equal(await page.locator("tbody tr").first().locator("td").nth(4).innerText(), "$2.50");
      await page.locator("#query").tap();
      // Desktop automation has no software keyboard; reduce the browser's own viewport.
      await page.setViewportSize({ width: 375, height: 320 });
      await page.locator("#query").pressSequentially("sou");
      assert.match(await page.locator("#summary").innerText(), /1 match/);
      assert.equal(await page.locator("tbody tr").count(), 1);
      const layout = await page.evaluate(() => {
        const rect = id => {
          const box = document.getElementById(id).getBoundingClientRect();
          return { top: box.top + scrollY, bottom: box.bottom + scrollY, height: box.height };
        };
        const item = document.querySelector("tbody .item-button").getBoundingClientRect();
        return { results: rect("results"), search: rect("query"), itemTop: item.top + scrollY, itemBottom: item.bottom + scrollY };
      });
      assert(layout.results.top >= 0);
      assert(layout.itemTop >= layout.results.top && layout.itemBottom <= layout.results.bottom,
        "The matching item remains visible while typing");
      assert(layout.search.top >= layout.results.bottom);
      assert(layout.search.bottom <= 320);
      assert.equal(await page.locator("#query").evaluate(element => element === document.activeElement), true);
      await page.locator("#query").blur();
      await page.setViewportSize({ width: 375, height: 667 });
      assert.equal(await page.locator("#query").inputValue(), "sou");
      assert.match(await page.locator("#summary").innerText(), /1 match/);
      await page.locator("#compact-sort-order").selectOption("category:desc");
      assert.equal(await page.locator("#query").inputValue(), "sou");
      assert.match(await page.locator("#summary").innerText(), /1 match/);
      await page.setViewportSize({ width: 1200, height: 800 });
      assert.equal(await page.locator("#compact-sort").isVisible(), false);
      assert.equal(await page.locator(".sort-controls").isVisible(), true);
      assert.equal(await page.locator("#sort-field").inputValue(), "category");
      assert.equal(await page.locator('th[data-field="category"]').getAttribute("aria-sort"), "descending");
      await page.locator('th[data-field="price"] button').click();
      await page.setViewportSize({ width: 375, height: 667 });
      assert.equal(await page.locator("#compact-sort-order").inputValue(), "price:asc");
      assert.deepEqual(errors, []);
    } finally { await browser.close(); await fs.rm(fixture.directory, { recursive: true }); }
  });
}

test("session storage fallback, blocked storage, partial/stale/missing/invalid data", async () => {
  const browser = await chromium.launch({ headless: true });
  const fixtures = [];
  try {
    const fixture = await site(snapshot("2026-10-26", true));
    fixtures.push(fixture);
    const context = await browser.newContext();
    await context.addInitScript(() => Object.defineProperty(window, "localStorage", {
      get() { throw new DOMException("blocked", "SecurityError"); },
    }));
    const page = await context.newPage();
    await page.goto(fixture.url);
    assert.match(await page.locator("#data-warning").innerText(), /Partial snapshot/);
    assert.match(await page.locator("#data-warning").innerText(), /not today/);
    assert.equal(await page.locator("#preferences-warning").isVisible(), false);
    await page.locator("#locations-button").click();
    assert.match(await page.locator("#preferences-warning").innerText(), /session only/);
    await page.getByRole("switch", { name: "Cafe 10", exact: true }).uncheck();
    assert.match(await page.locator("#location-list").innerText(), /HTTP 403/);
    await page.reload();
    assert.deepEqual(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), storageKey), ["cafe10.buy-ondemand.com"]);
    assert.match(await page.locator("#summary").innerText(), /207 matches/);
    await context.close();
    const blocked = await browser.newContext();
    await blocked.addInitScript(() => {
      for (const kind of ["localStorage", "sessionStorage"]) Object.defineProperty(window, kind, {
        get() { throw new DOMException("blocked", "SecurityError"); },
      });
    });
    const blockedPage = await blocked.newPage();
    const errors = [];
    blockedPage.on("pageerror", error => errors.push(error.message));
    await blockedPage.goto(fixture.url);
    assert.match(await blockedPage.locator("#summary").innerText(), /208 matches/);
    assert.equal(await blockedPage.locator("#preferences-warning").isVisible(), false);
    await blockedPage.locator("#locations-button").click();
    assert.match(await blockedPage.locator("#preferences-warning").innerText(), /cannot be saved/);
    const missing = await site(null);
    fixtures.push(missing);
    await blockedPage.goto(missing.url);
    assert.equal(await blockedPage.locator("#empty-title").innerText(), "Unable to load menus");
    assert.equal(await blockedPage.locator("#loading-screen").isVisible(), false);
    await blockedPage.locator("#about-button").click();
    assert.equal(await blockedPage.locator("#about-dialog").isVisible(), true);
    const invalid = await site({ schemaVersion: 999 });
    fixtures.push(invalid);
    await blockedPage.goto(invalid.url);
    assert.match(await blockedPage.locator("#empty-message").innerText(), /Unsupported menu data format/);
    assert.equal(await blockedPage.locator("#loading-screen").isVisible(), false);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    for (const fixture of fixtures) await fs.rm(fixture.directory, { recursive: true });
  }
});

test("static hosting, full-result batching, large text, and detail scroll preservation", async () => {
  const fixture = await site(snapshot());
  const html = await fs.readFile(path.join(fixture.directory, "index.html"));
  const menus = await fs.readFile(path.join(fixture.directory, "menus.js"));
  const server = http.createServer((request, response) => {
    if (request.url === "/menus.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(menus);
    } else if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html" }); response.end(html);
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    while (await page.locator("#more").isVisible()) await page.locator("#more").click();
    assert.equal(await page.locator("tbody tr").count(), 208);
    await page.locator("tbody tr").nth(150).getByRole("button").click();
    const scroll = await page.locator("#results").evaluate(element => element.scrollTop);
    assert(scroll > 0);
    await page.locator("#detail-dialog [data-close]").click();
    assert.equal(await page.locator("#results").evaluate(element => element.scrollTop), scroll);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "24px"; });
    await page.locator("#query").fill("fish");
    assert.match(await page.locator("#summary").innerText(), /1 match/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator("#query").isVisible(), true);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(fixture.directory, { recursive: true });
  }
});

test("optional real Rust-generated menus.js loads without external requests", {
  skip: !process.env.FOOD_FINDER_WEB_DATA,
}, async () => {
  const script = await fs.readFile(process.env.FOOD_FINDER_WEB_DATA, "utf8");
  const value = JSON.parse(script.split("const menuData = ")[1].replace(/;\s*$/, ""));
  const fixture = await site(value);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith("file:")) external.push(request.url()); });
    await page.goto(fixture.url);
    const count = value.locations.reduce((total, location) => total + location.items.length, 0);
    assert.match(await page.locator("#summary").innerText(), new RegExp(`${count.toLocaleString()} matches`));
    await page.locator("#locations-button").click();
    assert.equal(await page.locator(".location-row").count(), value.locations.length);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  } finally { await browser.close(); await fs.rm(fixture.directory, { recursive: true }); }
});
