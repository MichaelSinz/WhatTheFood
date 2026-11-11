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
  await Promise.all(["index.html", "wtf.css", "wtf.js", "WhatTheFood.svg", "apple-touch-icon.png"].map(file =>
    fs.copyFile(path.join(root, "web", file), path.join(directory, file))));
  if (data) await fs.writeFile(path.join(directory, "menus.js"), `const menuData = ${JSON.stringify(data)};\n`);
  return { directory, url: pathToFileURL(path.join(directory, "index.html")).href };
}

async function staticServer(fixture, menusReady = Promise.resolve()) {
  const assets = new Map(await Promise.all([
    ["/", "index.html", "text/html"],
    ["/wtf.css", "wtf.css", "text/css"],
    ["/wtf.js", "wtf.js", "text/javascript"],
    ["/WhatTheFood.svg", "WhatTheFood.svg", "image/svg+xml"],
    ["/apple-touch-icon.png", "apple-touch-icon.png", "image/png"],
    ["/menus.js", "menus.js", "text/javascript"],
  ].map(async ([route, file, type]) =>
    [route, { body: await fs.readFile(path.join(fixture.directory, file)), type }])));
  const server = http.createServer(async (request, response) => {
    const asset = assets.get(request.url);
    if (!asset) { response.writeHead(404); response.end(); return; }
    if (request.url === "/menus.js") await menusReady;
    response.writeHead(200, { "Content-Type": asset.type }); response.end(asset.body);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server;
}

for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  test(`${name}: centered full icon stays visible until menu data loads`, async () => {
    const fixture = await site(snapshot());
    let releaseMenus;
    const ready = new Promise(resolve => { releaseMenus = resolve; });
    const server = await staticServer(fixture, ready);
    const browser = await engine.launch({
      headless: true,
      ...(name === "webkit" && process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE } : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
      await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "commit" });
      await page.locator("#loading-screen img").waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const image = document.querySelector("#loading-screen img");
        return image.complete && image.naturalWidth > 0;
      });
      for (const viewport of [{ width: 375, height: 667 }, { width: 1200, height: 800 }]) {
        await page.setViewportSize(viewport);
        const artwork = await page.locator("#loading-screen img").boundingBox();
        assert(Math.abs(artwork.width - artwork.height) < 1, "The complete square icon is not stretched");
        assert(Math.abs(artwork.x + artwork.width / 2 - viewport.width / 2) < 1);
        assert(Math.abs(artwork.y + artwork.height / 2 - viewport.height / 2) < 1);
        assert(artwork.width >= Math.min(viewport.width, viewport.height) * 0.89);
        assert.equal(await page.locator("tbody tr").count(), 0);
      }
      releaseMenus();
      await page.waitForLoadState("load");
      await page.locator("#loading-screen").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#loading-screen").isVisible(), false);
      assert.match(await page.locator("#summary").innerText(), /208 matches/);
      for (const viewport of [{ width: 375, height: 667 }, { width: 1200, height: 800 }]) {
        await page.setViewportSize(viewport);
        for (const colorScheme of ["light", "dark"]) {
          await page.emulateMedia({ colorScheme });
          const results = page.locator("#results");
          const watermark = await results.screenshot();
          await results.evaluate(element => { element.style.backgroundImage = "none"; });
          const plain = await results.screenshot();
          assert(!watermark.equals(plain), `Watermark remains visible behind ${colorScheme} menu rows at ${viewport.width}px`);
          await results.evaluate(element => { element.style.removeProperty("background-image"); });
        }
      }
      const noScript = await browser.newPage({ javaScriptEnabled: false });
      await noScript.goto(`http://127.0.0.1:${server.address().port}/`);
      assert.equal(await noScript.locator("#loading-screen").isVisible(), false);
      assert.equal(await noScript.locator("noscript p").isVisible(), true);
      await noScript.emulateMedia({ colorScheme: "light" });
      const lightBackground = await noScript.locator("body").evaluate(element => getComputedStyle(element).backgroundColor);
      await noScript.emulateMedia({ colorScheme: "dark" });
      const darkBackground = await noScript.locator("body").evaluate(element => getComputedStyle(element).backgroundColor);
      assert.notEqual(darkBackground, lightBackground, "Color themes follow the browser without JavaScript");
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
      await page.locator("#loading-screen").waitFor({ state: "hidden" });
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
      await page.locator("#loading-screen").waitFor({ state: "hidden" });
      const iconSize = await page.locator('link[rel="apple-touch-icon"]').evaluate(async link => {
        const image = new Image();
        image.src = link.href;
        await image.decode();
        return [image.naturalWidth, image.naturalHeight];
      });
      assert.deepEqual(iconSize, [180, 180]);
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
      assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).sort()),
        [storageKey, "what-the-food.vendors.v1", "what-the-food.categories.v1", "what-the-food.searches.v1"].sort());
      await page.reload();
      await page.locator("#loading-screen").waitFor({ state: "hidden" });
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

  test(`${name}: All locations checkbox tracks mixed selection and saves bulk changes`, async () => {
    const fixture = await site(snapshot("2026-10-27", true));
    const browser = await engine.launch({
      headless: true,
      ...(name === "webkit" && process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE } : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width: 375, height: 320 } });
      await page.goto(fixture.url);
      await page.locator("#loading-screen").waitFor({ state: "hidden" });
      await page.locator("#locations-button").click();
      const all = page.getByRole("checkbox", { name: "Select All", exact: true });
      const cafe = page.getByRole("switch", { name: "Cafe 2", exact: true });
      const switches = page.getByRole("switch");
      const state = () => all.evaluate(input => [input.checked, input.indeterminate]);
      assert.deepEqual(await state(), [true, false]);
      assert.equal(await switches.count(), 3, "Unlinked locations are not selectable");
      await cafe.uncheck();
      assert.deepEqual(await state(), [false, true]);
      await all.click();
      assert.deepEqual(await state(), [true, false]);
      assert.equal(await switches.evaluateAll(inputs => inputs.every(input => input.checked)), true);
      await page.getByRole("switch", { name: "Failed", exact: true }).uncheck();
      assert.deepEqual(await state(), [false, true], "Failed locations count toward the selection");
      await page.getByRole("switch", { name: "Failed", exact: true }).check();
      assert.deepEqual(await state(), [true, false]);
      await page.locator("#locations-dialog").evaluate(dialog => { dialog.scrollTop = dialog.scrollHeight; });
      const header = await all.boundingBox();
      const dialog = await page.locator("#locations-dialog").boundingBox();
      assert(header.y >= dialog.y && header.y + header.height <= dialog.y + dialog.height,
        "All remains visible while the locations list is scrolled");
      await all.click();
      assert.deepEqual(await state(), [false, false]);
      assert.equal(await switches.evaluateAll(inputs => inputs.every(input => !input.checked)), true);
      assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey),
        ["cafe2.buy-ondemand.com", "cafe10.buy-ondemand.com", "failed"]);
      await page.locator("#locations-dialog [data-close]").click();
      await page.reload();
      await page.locator("#loading-screen").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#empty-title").textContent(), "No locations enabled");
      await page.locator("#locations-button").click();
      assert.deepEqual(await state(), [false, false]);
      await all.click();
      assert.deepEqual(await state(), [true, false]);
      await page.reload();
      await page.locator("#loading-screen").waitFor({ state: "hidden" });
      assert.match(await page.locator("#summary").innerText(), /208 matches/);
      await page.locator("#locations-button").click();
      assert.deepEqual(await state(), [true, false]);
    } finally { await browser.close(); await fs.rm(fixture.directory, { recursive: true }); }
  });

  test(`${name}: frequent searches rank completed queries and support touch and keyboard`, async () => {
    const fixture = await site(snapshot());
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 375, height: 667 }, hasTouch: true });
      const requests = [], errors = [];
      page.on("request", request => requests.push(request.url()));
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(fixture.url);
      await page.locator("#loading-screen").waitFor({ state: "hidden" });
      const query = page.locator("#query");
      const suggestions = page.locator("#search-suggestions button");
      const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("what-the-food.searches.v1")));
      for (const text of ["Soup", "Fish", "Cafe", "Lunch", "Entrees", "Vendor", "Dish"]) {
        await query.fill(text);
        await query.press("Enter");
        await query.blur();
      }
      assert.equal((await saved()).length, 7);
      assert((await saved()).every(entry => entry.count === 1), "Enter and blur count the same edit only once");
      for (const text of ["   ", '""']) {
        await query.fill(text);
        await query.press("Enter");
        await query.blur();
      }
      assert.equal((await saved()).length, 7, "Empty queries are not saved");
      await query.fill("SOUP");
      await query.blur();
      await query.fill("");
      assert.deepEqual(await suggestions.allTextContents(), ["SOUP", "Dish", "Vendor", "Entrees", "Lunch", "Cafe"]);
      assert.equal(await query.getAttribute("aria-expanded"), "true");
      await suggestions.getByText("SOUP", { exact: true }).tap();
      assert.equal(await query.inputValue(), "SOUP");
      assert.match(await page.locator("#summary").textContent(), /1 match/);
      assert.equal(await page.locator("#search-history").isVisible(), false);
      assert.equal((await saved()).find(entry => entry.query === "SOUP").count, 3);
      await query.blur();
      assert.equal((await saved()).find(entry => entry.query === "SOUP").count, 3);
      await query.fill("so");
      await suggestions.getByText("SOUP", { exact: true }).tap();
      assert.equal(await query.inputValue(), "SOUP");
      assert.equal((await saved()).some(entry => entry.query === "so"), false, "Tapping a suggestion does not save a fragment");
      await query.fill("di");
      assert.deepEqual(await suggestions.allTextContents(), ["Dish"]);
      await query.press("ArrowDown");
      await page.keyboard.press("Enter");
      assert.equal(await query.inputValue(), "Dish");
      assert.equal((await saved()).some(entry => entry.query === "di"), false, "Choosing a suggestion does not save a fragment");
      await query.press("ArrowDown");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#search-history").isVisible(), false);
      assert.equal(await query.evaluate(input => input === document.activeElement), true);
      await page.reload();
      await page.locator("#loading-screen").waitFor({ state: "hidden" });
      assert.equal(await query.inputValue(), "", "The active query is not restored");
      await query.tap();
      assert.deepEqual(await suggestions.allTextContents(), ["SOUP", "Dish", "Vendor", "Entrees", "Lunch", "Cafe"]);
      await page.setViewportSize({ width: 375, height: 320 });
      const box = await page.locator("#search-history").boundingBox();
      assert(box.y >= 0 && box.y + box.height <= 320, "Suggestions fit above the search field with a reduced viewport");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert(requests.every(url => url.startsWith("file:")), "History never makes network requests");
      assert.deepEqual(errors, []);
    } finally { await browser.close(); await fs.rm(fixture.directory, { recursive: true }); }
  });

  test(`${name}: vendor and category exclusions combine and survive changing daily menus`, async () => {
    const data = snapshot();
    const first = data.locations[0].items[0], second = data.locations[1].items[0];
    data.locations[0].items = [
      { ...first, vendor: "Moving cart", category: "Lunch / Sides" },
      { ...first, id: first.id + "bakery", name: "Bread", vendor: "Anchor", category: "Breakfast / Bakery" },
    ];
    data.locations[1].items = [
      { ...second, vendor: "Moving cart", category: "Dinner / Sides" },
      { ...second, id: second.id + "coffee", name: "Coffee", vendor: "Coffee", category: "Drinks / Hot Coffee" },
    ];
    const fixture = await site(data);
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.clock.install({ time: new Date("2026-10-27T19:00:00Z") });
      await page.goto(fixture.url);
      await page.locator("#loading-screen").waitFor({ state: "hidden" });
      await page.locator("#locations-button").click();
      await page.getByRole("radio", { name: "Categories", exact: true }).check();
      assert.deepEqual(await page.getByRole("switch").evaluateAll(inputs =>
        inputs.map(input => input.parentElement.textContent)), ["Bakery", "Hot Coffee", "Sides"]);
      await page.getByRole("switch", { name: "Sides", exact: true }).uncheck();
      assert.match(await page.locator("#summary").textContent(), /2 matches/);
      await page.getByRole("switch", { name: "Sides", exact: true }).check();
      await page.getByRole("radio", { name: "Vendors", exact: true }).check();
      assert.equal(await page.getByRole("switch").count(), 3, "Duplicate vendor names are grouped across locations");
      await page.getByRole("switch", { name: "Moving cart", exact: true }).uncheck();
      assert.match(await page.locator("#summary").textContent(), /2 matches/);
      await page.getByRole("radio", { name: "Categories", exact: true }).check();
      assert.equal(await page.getByRole("switch", { name: "Sides", exact: true }).isChecked(), true,
        "Vendor exclusions do not hide or alter category choices");
      await page.getByRole("switch", { name: "Bakery", exact: true }).uncheck();
      assert.match(await page.locator("#summary").textContent(), /1 match/);
      await page.clock.setSystemTime(new Date("2026-10-28T07:01:00Z"));
      await page.clock.runFor(1000);
      assert.match(await page.locator("#summary").textContent(), /1 match \/ 1 items/,
        "Clock updates preserve the filtered item total");
      await page.getByRole("radio", { name: "Locations", exact: true }).check();
      await page.getByRole("switch", { name: "Cafe 10", exact: true }).uncheck();
      assert.match(await page.locator("#summary").textContent(), /0 matches/);
      await page.reload();
      await page.locator("#loading-screen").waitFor({ state: "hidden" });
      assert.match(await page.locator("#empty-title").textContent(), /filters/);
      const nextDay = snapshot();
      nextDay.locations[0].items = [{ ...first, vendor: "New vendor", category: "Lunch / New category" }];
      nextDay.locations[1].items = [data.locations[1].items[1]];
      await fs.writeFile(path.join(fixture.directory, "menus.js"), `const menuData = ${JSON.stringify(nextDay)};\n`);
      await page.reload();
      await page.locator("#loading-screen").waitFor({ state: "hidden" });
      assert.match(await page.locator("#summary").textContent(), /1 match/, "New names are included by default");
      await page.locator("#locations-button").click();
      await page.getByRole("radio", { name: "Vendors", exact: true }).check();
      assert.equal(await page.getByRole("switch", { name: "Moving cart", exact: true }).isChecked(), false);
      assert.equal(await page.getByRole("switch", { name: "New vendor", exact: true }).isChecked(), true);
      assert.match(await page.locator("#location-list").textContent(), /Not in this snapshot/);
      await page.getByRole("radio", { name: "Categories", exact: true }).check();
      assert.equal(await page.getByRole("switch", { name: "Bakery", exact: true }).isChecked(), false);
      assert.equal(await page.getByRole("switch", { name: "New category", exact: true }).isChecked(), true);
      // Saving a different filter set must not prune exclusions missing from today's data.
      await page.getByRole("switch", { name: "New category", exact: true }).uncheck();
      await page.getByRole("switch", { name: "New category", exact: true }).check();
      await fs.writeFile(path.join(fixture.directory, "menus.js"), `const menuData = ${JSON.stringify(data)};\n`);
      await page.reload();
      await page.locator("#loading-screen").waitFor({ state: "hidden" });
      assert.match(await page.locator("#summary").textContent(), /0 matches/, "Returning vendors and categories remain excluded");
      await page.locator("#locations-button").click();
      await page.locator("#all-locations").check();
      assert.match(await page.locator("#summary").textContent(), /1 match/);
      await page.getByRole("radio", { name: "Vendors", exact: true }).check();
      await page.locator("#all-locations").check();
      assert.match(await page.locator("#summary").textContent(), /3 matches/);
      await page.getByRole("radio", { name: "Categories", exact: true }).check();
      assert.equal(await page.getByRole("switch", { name: "Bakery", exact: true }).isChecked(), false);
      await page.locator("#all-locations").check();
      assert.match(await page.locator("#summary").textContent(), /4 matches/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); await fs.rm(fixture.directory, { recursive: true }); }
  });

  test(`${name}: category aliases share filters and normalize saved exclusions across menu days`, async () => {
    const groups = [
      ["Entr\u00e9es", ["Entrees", "Entr\u00e9e", "Entr\u00e9es"]],
      ["\u00c0 la carte", ["A La Carte", "\u00c0 la carte"]],
      ["Breakfast", ["Breakfast", "Breakfast ", "BREAKFAST", "\u00a0Breakfast\t"]],
      ["Chef's Table", ["Chef Table", "Chef's Table", "Chef\u2019s Table"]],
      ["Cold Drinks", ["Cold Dinks", "Cold Drinks"]],
      ["Himalaya", ["Himalaya", "Himalayan"]],
      ["Pizza", ["Pizza", "Pizzas"]],
      ["Sandwiches", ["Sandwiches", "Half Sandwiches", "Whole Sandwiches"]],
      ["Sandwiches + More", ["Sandwiches & More", "Sandwiches + More"]],
      ["Sides + Dessert", ["Sides & Dessert", "Sides + Dessert"]],
      ["Small Plates", ["Small Plate", "Small Plates"]],
      ["Soups + Sides", ["Soups & Sides", "Soups + Sides", "Soups and Sides"]],
      ["Teriyaki", ["Teriayki", "Teriyaki", "Teriyaki "]],
      ["Tea + Elixirs", ["Tea + Elixers", "Tea + Elixirs"]],
      ["Burgers", ["Burgers "]],
      ["Chicken", ["Chicken "]],
      ["Dogs", ["Dogs "]],
      ["New Category", ["New Category", "NEW CATEGORY ", "Ne\u0301w  Category"]],
      ["Matcha Series", ["Matcha Series 16oz", "Matcha Series 20oz", "Matcha Series 16 OZ"]],
      ["Milk Tea Series", ["Milk Tea Series 16oz", "Milk Tea Series 20oz"]],
      ["Famous Series", ["Famous Series 16oz", "Famous Series 20oz"]],
      ["Nitro Tea Series", ["Nitro Tea Series 16oz", "Nitro Tea Series 20oz"]],
      ["Seasonal Options", ["Seasonal Options 16oz", "Seasonal Options 20oz"]],
      ["Specialty Coffee Series", ["Specialty Coffee Series 16oz", "Specialty Coffee Series 20oz"]],
      ["Iced Tea", ["Iced Tea 12 fl. oz", "Iced Tea 500ml", "Iced Tea 0.5L"]],
    ];
    const distinct = [
      "Hot Breakfast", "Breakfast - Available All Day", "Entr\u00e9es + Sides",
      "Pizza By The Slice", "Signature Sandwiches",
      "Watercress Entrees", "Large Plate", "Specialty Coffee Series 2", "16oz",
    ];
    const categories = [...groups.flatMap(([, variants]) => variants), ...distinct];
    const data = snapshot();
    const first = data.locations[0].items[0];
    data.locations[0].items = categories.map((category, index) => ({
      ...first, id: first.id + index, name: `Variant ${index}`, category: `Menu / ${category}`,
    }));
    data.locations[1].items = [];
    const fixture = await site(data);
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(fixture.url);
      await page.locator("#loading-screen").waitFor({ state: "hidden" });
      await page.locator("#locations-button").click();
      await page.getByRole("radio", { name: "Categories", exact: true }).check();
      assert.equal(await page.getByRole("switch").count(), groups.length + distinct.length);
      for (const [label, variants] of groups) {
        const toggle = page.getByRole("switch", { name: label, exact: true });
        assert.equal(await toggle.count(), 1, label);
        await toggle.uncheck();
        assert.equal(await page.locator("tbody tr").count(), categories.length - variants.length, label);
        await toggle.check();
      }
      for (const label of distinct)
        assert.equal(await page.getByRole("switch", { name: label, exact: true }).isChecked(), true, label);
      await page.locator("#locations-dialog [data-close]").click();
      await page.getByRole("button", { name: "Variant 0", exact: true }).click();
      assert.equal(await page.locator("#detail-category").textContent(), "Menu / Entrees",
        "Provider category text remains unchanged");
      await page.locator("#detail-dialog [data-close]").click();
      await page.evaluate(() => localStorage.setItem("what-the-food.categories.v1", JSON.stringify([
        "Entr\u00e9e", "Entrees", "\u00a0Breakfast ", "Teriayki", "Missing\u00a0  Category",
        "Matcha Series 16oz", "Matcha Series 20oz", "Milk Tea Series 16oz",
        "Half Sandwiches", "Whole Sandwiches",
      ])));
      await page.reload();
      await page.locator("#loading-screen").waitFor({ state: "hidden" });
      assert.equal(await page.locator("tbody tr").count(), categories.length - 18,
        "Earlier spellings and duplicate exclusions use the current normalization on load");
      await page.locator("#locations-button").click();
      await page.getByRole("radio", { name: "Categories", exact: true }).check();
      assert.equal(await page.getByRole("switch", { name: "Entr\u00e9es", exact: true }).isChecked(), false);
      assert.equal(await page.getByRole("switch", { name: "Missing Category", exact: true }).isChecked(), false);
      await page.getByRole("switch", { name: "Pizza", exact: true }).uncheck();
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("what-the-food.categories.v1"))),
        ["Entr\u00e9es", "Breakfast", "Teriyaki", "Missing Category", "Matcha Series", "Milk Tea Series", "Sandwiches", "Pizza"]);
      data.locations[0].items = [
        "ENTR\u00c9E", "bre\u0301akfast\t", "Teriayki\u00a0", "Missing CATEGORY", "PIZZAS",
        "MATCHA SERIES 24 oz", "Milk Tea Series 500ml", "Sandwiches", "HALF SANDWICHES", "Brand new category",
      ].map((category, index) => ({ ...first, id: first.id + index, name: `Tomorrow ${index}`, category: `New menu / ${category}` }));
      await fs.writeFile(path.join(fixture.directory, "menus.js"), `const menuData = ${JSON.stringify(data)};\n`);
      await page.reload();
      await page.locator("#loading-screen").waitFor({ state: "hidden" });
      assert.equal(await page.locator("tbody tr").count(), 1, "Exclusions match new spellings on later days");
      assert.equal(await page.locator("tbody .item-button").textContent(), "Tomorrow 9");
      await page.locator("#locations-button").click();
      await page.getByRole("radio", { name: "Categories", exact: true }).check();
      await page.getByRole("switch", { name: "Entr\u00e9es", exact: true }).check();
      assert.equal(await page.locator("tbody tr").count(), 2);
      assert.deepEqual(errors, []);
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
      await page.locator("#loading-screen").waitFor({ state: "hidden" });
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
    await page.locator("#loading-screen").waitFor({ state: "hidden" });
    assert.match(await page.locator("#data-warning").innerText(), /Partial snapshot/);
    assert.match(await page.locator("#data-warning").innerText(), /not today/);
    assert.equal(await page.locator("#preferences-warning").isVisible(), false);
    await page.locator("#locations-button").click();
    assert.match(await page.locator("#preferences-warning").innerText(), /session only/);
    await page.getByRole("switch", { name: "Cafe 10", exact: true }).uncheck();
    assert.match(await page.locator("#location-list").innerText(), /HTTP 403/);
    await page.getByRole("radio", { name: "Vendors", exact: true }).check();
    await page.getByRole("switch", { name: "Caf\u00e9 Vendor", exact: true }).uncheck();
    await page.getByRole("radio", { name: "Categories", exact: true }).check();
    await page.getByRole("switch", { name: "Entr\u00e9es", exact: true }).uncheck();
    await page.locator("#locations-dialog [data-close]").click();
    await page.locator("#query").fill("soup");
    await page.locator("#query").press("Enter");
    await page.reload();
    await page.locator("#loading-screen").waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), storageKey), ["cafe10.buy-ondemand.com"]);
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("what-the-food.vendors.v1"))), ["Caf\u00e9 Vendor"]);
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("what-the-food.categories.v1"))), ["Entr\u00e9es"]);
    assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("what-the-food.searches.v1"))[0].query), "soup");
    assert.match(await page.locator("#summary").innerText(), /0 matches/);
    await context.close();
    const corrupt = await browser.newContext();
    await corrupt.addInitScript(key => {
      localStorage.setItem(key, JSON.stringify(["cafe10.buy-ondemand.com"]));
      localStorage.setItem("what-the-food.vendors.v1", "{}");
      localStorage.setItem("what-the-food.searches.v1", JSON.stringify([{ query: "soup", count: "bad" }]));
    }, storageKey);
    const corruptPage = await corrupt.newPage();
    await corruptPage.goto(fixture.url);
    await corruptPage.locator("#loading-screen").waitFor({ state: "hidden" });
    assert.match(await corruptPage.locator("#summary").textContent(), /207 matches/,
      "Invalid new preferences do not discard existing location exclusions");
    await corruptPage.locator("#locations-button").click();
    assert.match(await corruptPage.locator("#preferences-warning").textContent(), /could not be read/);
    await corrupt.close();
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
    await blockedPage.locator("#loading-screen").waitFor({ state: "hidden" });
    assert.match(await blockedPage.locator("#summary").innerText(), /208 matches/);
    assert.equal(await blockedPage.locator("#preferences-warning").isVisible(), false);
    await blockedPage.locator("#query").fill("soup");
    await blockedPage.locator("#query").press("Enter");
    await blockedPage.locator("#query").fill("");
    assert.deepEqual(await blockedPage.locator("#search-suggestions button").allTextContents(), ["soup"]);
    await blockedPage.locator("#locations-button").click();
    assert.match(await blockedPage.locator("#preferences-warning").innerText(), /cannot be saved/);
    const missing = await site(null);
    fixtures.push(missing);
    await blockedPage.goto(missing.url);
    await blockedPage.locator("#loading-screen").waitFor({ state: "hidden" });
    assert.equal(await blockedPage.locator("#empty-title").innerText(), "Unable to load menus");
    assert.equal(await blockedPage.locator("#loading-screen").isVisible(), false);
    await blockedPage.locator("#locations-button").click();
    await blockedPage.getByRole("radio", { name: "Vendors", exact: true }).check();
    assert.equal(await blockedPage.locator("#all-locations").isDisabled(), true);
    await blockedPage.locator("#locations-dialog [data-close]").click();
    await blockedPage.locator("#about-button").click();
    assert.equal(await blockedPage.locator("#about-dialog").isVisible(), true);
    const invalid = await site({ schemaVersion: 999 });
    fixtures.push(invalid);
    await blockedPage.goto(invalid.url);
    await blockedPage.locator("#loading-screen").waitFor({ state: "hidden" });
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
  const server = await staticServer(fixture);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator("#loading-screen").waitFor({ state: "hidden" });
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
    await page.locator("#loading-screen").waitFor({ state: "hidden" });
    const count = value.locations.reduce((total, location) => total + location.items.length, 0);
    assert.match(await page.locator("#summary").innerText(), new RegExp(`${count.toLocaleString()} matches`));
    await page.locator("#locations-button").click();
    assert.equal(await page.locator(".location-row").count(), value.locations.length);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  } finally { await browser.close(); await fs.rm(fixture.directory, { recursive: true }); }
});
