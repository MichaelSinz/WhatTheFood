// Check browser readiness before starting the test suite. Never install system packages.
const path = require("node:path");
const { chromium, webkit } = require("playwright");

async function checkBrowsers(engines, report = console.error) {
  let ready = true;
  let missingLibraries = false;
  for (const [name, engine] of Object.entries(engines)) {
    let browser;
    try {
      browser = await engine.launch({ headless: true });
      await browser.newPage();
    } catch (error) {
      ready = false;
      missingLibraries ||= /missing dependencies|error while loading shared libraries|Library not loaded|cannot open shared object file/i.test(error.message);
      report(`${name} is not ready:\n${error.message}`);
    } finally {
      if (browser) await browser.close();
    }
  }
  if (missingLibraries) {
    const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    report(`Install the native system libraries, then rerun make test-web:\n  ${quote(process.execPath)} ${quote(cli)} install-deps chromium webkit\nThis installs system dependencies only, not system browsers. Add elevation appropriate to your system if required.`);
  }
  return ready;
}

if (require.main === module) {
  checkBrowsers({ chromium, webkit }).then(ready => {
    process.exitCode = ready ? 0 : 1;
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { checkBrowsers };
