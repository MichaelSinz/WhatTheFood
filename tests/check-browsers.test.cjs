const { test } = require("node:test");
const assert = require("node:assert/strict");
const { checkBrowsers } = require("./check-browsers.cjs");

test("browser readiness succeeds without diagnostics when both browsers open", async () => {
  const messages = [];
  let closed = 0;
  const engine = {
    launch: async () => ({
      newPage: async () => {},
      close: async () => { closed++; },
    }),
  };
  assert.equal(await checkBrowsers({ chromium: engine, webkit: engine }, message => messages.push(message)), true);
  assert.equal(closed, 2);
  assert.deepEqual(messages, []);
});

test("browser readiness closes browsers and reports missing native libraries without installing them", async () => {
  const messages = [];
  let closed = false;
  const ready = await checkBrowsers({
    chromium: {
      launch: async () => ({
        newPage: async () => {},
        close: async () => { closed = true; },
      }),
    },
    webkit: {
      launch: async () => { throw new Error("Host system is missing dependencies to run browsers."); },
    },
  }, message => messages.push(message));
  assert.equal(ready, false);
  assert.equal(closed, true);
  assert.match(messages.join("\n"), /install-deps chromium webkit/);
  assert.match(messages.join("\n"), /not system browsers/);
  assert.doesNotMatch(messages.join("\n"), /sudo/);
});

test("browser readiness reports other failures without recommending system packages", async () => {
  const messages = [];
  let closed = false;
  const ready = await checkBrowsers({
    webkit: {
      launch: async () => ({
        newPage: async () => { throw new Error("Renderer failed"); },
        close: async () => { closed = true; },
      }),
    },
  }, message => messages.push(message));
  assert.equal(ready, false);
  assert.equal(closed, true);
  assert.match(messages.join("\n"), /Renderer failed/);
  assert.doesNotMatch(messages.join("\n"), /install-deps/);
});
