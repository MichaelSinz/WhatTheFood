# What the Food: project reference

This repository contains the standalone Rust scraper and web app.  Keep implementation notes here and user-facing instructions in `README.md`.  Prefer the simplest implementation that meets the requirements, using browser/platform capabilities rather than custom infrastructure.

## Deployment and use

Rust sources live in `rust/`, the HTML source in `site/index.html`, and browser tests in `tests/web.test.cjs`.  The root Makefile generates the deployable `web/` directory, which contains exactly `index.html` and `menus.js`.  Do not put tests, documentation, ignore files, or development dependencies there.  Root `.gitignore` covers generated files and build/test products.

The HTML contains its CSS, application JavaScript, and the original `WhatTheFood.svg` embedded at build time with portable awk.  It uses an ordinary, non-module script tag to load `menus.js`.  It works directly from disk as well as on a static web host; it makes no menu API requests and requires no application server, CDN, or external application runtime.  The full, uncropped SVG is scaled and centered over the page until menu validation, indexing, and the initial rendering of results are complete.  Missing or invalid menu data dismisses the splash and shows the normal error screen; disabling JavaScript exposes a helpful message rather than leaving the splash covering the page.

Build and run from the repository root:

```sh
make help
make web
# Build the scraper with tests, or regenerate HTML without scraping:
make food-finder
make html
# No --output: emit only the JavaScript data to stdout.
rust/target/release/food-finder --urls locations.json > web/menus.js
# Optional exact-name selection, alternate catalog, and concurrency:
rust/target/release/food-finder --urls locations.json --location "Food Hall 6" --concurrency 2 --output web/menus.js
rust/target/release/food-finder --urls alternate-locations.json --output web/menus.js
```

The scraper fetches fresh data on every invocation, with no request or menu cache.  The required `--urls` option names the JSON location catalog loaded at runtime; no URLs are compiled into the executable.  Use the existing `locations.json` format: an array of objects with `name` and `url` fields, with null URLs for unlinked entries.  Editing or replacing this file takes effect on the next run without recompiling.  The previous `--catalog` spelling remains accepted as an alias.  A missing or invalid file is an explicit error and does not replace existing output.

Before fetching, validate the selected locations' names and snapshot IDs.  Names must not be blank.  IDs use the parsed URL hostname, falling back to the name when there is no hostname, and must be unique across linked and unlinked entries.  Reject collisions rather than silently dropping locations or publishing a snapshot the page cannot load; leave existing output untouched and stdout empty on these errors.

The scraper uses independent anonymous credentials and cookie jars for each host, and fetches up to four locations concurrently by default.  Credentials stay in memory and never enter the generated script.  Pickup windows closing at midnight use the end of the current day; windows too short for a complete interval contribute no slots.  ASAP-only ordering and other overnight scheduling remain explicit errors rather than guessed behavior.

### Ordering protocol

The public ordering client uses these routes, relative to each ordering site's HTTPS base:

| Method | API route | Purpose |
| --- | --- | --- |
| GET | `api/login/anonymous` | Bearer token in response headers, CSRF token in JSON, and a session cookie |
| GET | `api/config` | Tenant ID and scheduling configuration |
| GET | `api/sites/{tenantId}` | Stores, display profiles, timezones, opening windows, and pricing context |
| POST | `api/sites/{tenantId}/{siteId}/concepts/{displayProfileId}` | Vendors for today's selected pickup interval |
| POST | `api/sites/{tenantId}/{siteId}/concepts/{displayProfileId}/menus/{conceptId}` | Resolve today's vendor menus |
| POST | `api/sites/{tenantId}/{siteId}/kiosk-items/get-items` | Resolve item/package IDs that are not already populated |

Authenticated requests use the anonymous bearer; POSTs also require the CSRF header and retained login cookie.  Scheduling uses server-provided windows, interval alignment, and buffer, targeting noon or the next valid later slot with `scheduledDay: 0`.  Do not index concept metadata as menus because it can contain other weekdays.  The menus endpoint must resolve today's actual menu.

Traverse categories recursively, keeping their names as a path.  Categories can contain populated item objects or IDs requiring lookup; never send populated objects as IDs.  Preserve decimal-string effective prices and currency, prefer guest-facing `displayText`, and exclude entries explicitly unavailable to guests.  Embedded menu errors with status 410 are unavailable-menu notices; other errors fail the location.  No cart, order, reservation, or payment requests are made.  Stop on HTTP failures rather than bypassing access controls or bot challenges.

Output is a readable `const menuData = { ... };` script with newlines and two-space indentation.  Named files and stdout use the same formatter.

All progress, warnings, notices, and errors go to stderr.  With `--output`, the scraper writes a temporary file in the destination directory and atomically replaces the named file only after the complete script is written.  Shell redirection to stdout cannot provide that atomic replacement guarantee; use `--output` when updating deployed data.  Daily generated scripts are ignored by git.

A location failure does not discard other locations' successful results.  The scraper writes an explicitly partial snapshot, including the failed locations and their error messages.  When at most half of the selected linked locations fail, it warns on stderr and exits successfully; when more than half fail (including all linked locations failing), it reports an error and exits nonzero after writing the snapshot.  Unlinked directory entries are excluded from the threshold, and successfully fetched closed/unavailable or empty menus count as successes.  A fatal configuration/write error still exits nonzero; a run crossing campus midnight refuses publication rather than mixing menu days.  Automations should monitor exit status and stderr, and must check the snapshot's `complete` field before deployment if only complete snapshots should be published.

The binary uses Rustls instead of a system OpenSSL dependency, with bundled public HTTPS certificate roots and timezone data.  Release builds enable LTO, a single code-generation unit, and symbol stripping without changing panic/unwinding behavior.  `make food-finder TARGET=<target>` runs host unit/CLI tests before cross-compiling; musl targets are the supported path to fully static Linux deployment, with the appropriate Rust target and C/linker toolchain installed.  Build separately for each destination OS/architecture.  macOS executables still link Apple system libraries; they require no separately installed Rust runtime.  Only the native macOS binary has been built and exercised here; Linux static linkage needs verification on the deployment build machine.

## Browser behavior

The versioned data envelope includes the campus date, generation timestamp, completeness, location statuses/notices, and items with decimal-string base prices, currency, ordering destinations, and optional dated vendor opening windows.  The page validates the format, clearly labels partial and out-of-date snapshots, and retains old menus for explicitly dated browsing rather than calling them today's menus.  Its reload control reloads the generated file; it does not run the scraper.  A static host should configure revalidation or a short cache lifetime for `menus.js`.

The UI provides a search field in the footer, a responsive list/table layout, natural and numeric sorting, location switches, details, and time-aware browser ordering handoff.  It renders menu text as text rather than HTML and does not request per-item images.  Results are sorted and filtered over the full snapshot and inserted in batches while scrolling.  Search, sorting, and detail navigation do not contact the network.

Search uses AND across all words and double-quoted phrases, ignoring case and accents.  Each phrase must occur within one field, so `"Food hall 6" chicken` requires that phrase and the word chicken without matching Food Hall 4 merely because its price contains a 6.  Straight and smart double quotes are accepted; repeated whitespace is normalized.  An unfinished opening quote treats the remaining text as a phrase for incremental searching, and empty quotes are ignored.  No fuzzy matching or relevance ranking is added; the chosen column sort remains authoritative.

The search box has a persistent circled-X clear button at its right edge.  It stays visible but dimmed and disabled when empty, avoiding layout shifts while typing.  Clearing immediately restores the unfiltered results and returns focus to the search input.

On small screens, the footer contains only search.  Sorting uses a compact up/down-arrow icon beside About, with a native select offering each column in ascending or descending order; let the browser supply its dropdown/picker rather than implementing a custom menu.  Wide screens retain footer sorting and clickable table headers.  Both controls share the same sort state across layout changes.

Let the browser handle keyboard viewport scrolling and sizing; do not resize or reposition the page using visual-viewport JavaScript.  The viewport metadata requests native content resizing where supported, and the layout uses CSS dynamic viewport height.  Browser tests exercise typing in a reduced viewport; desktop mobile emulation does not open a real phone keyboard.

Fresh scraper output includes optional `orderingCategoryPath` metadata.  During verified opening hours, the ordering link appends the first menu's returned category ID (for example `/0` or `/1`), plus the immediate subcategory ID when available.  Preserve the provider's IDs rather than calculating positions after filtering hidden or empty categories.  The website supports only the first menu and two category levels; other menus use the vendor link, and deeper trees use the closest supported parent.  Older scripts without this metadata continue to use vendor links.  Outside the dated opening window, links still use pickup-time selection without category suffixes.

Only the disabled location IDs are persisted, as a small array under `what-the-food.locations.v1`; search and sorting stay in memory, and the menu script itself is the persistent menu snapshot.  Storage selection probes local storage, falls back to session storage, and keeps the page functional when neither is usable.  Storage notices belong only in the Locations panel, not the main screen.  File-URL storage behavior is browser-specific.

The browser restrictions were checked on Food Hall 6: the API login did not grant the standalone page cross-origin access, and the site sends `X-Frame-Options: DENY` plus a CSP `frame-ancestors` allowlist that excludes an arbitrary standalone page.  An iframe also would not grant cross-origin script access.  Generating the data script outside the browser avoids these restrictions without proxying through a third party or weakening browser security.  `menus.js` is executable JavaScript: deploy only a script produced by the trusted scraper, not arbitrary downloaded scripts.

## GitHub Pages deployment

The workflow in `.github/workflows/pages.yml` runs `make quick-web` on `ubuntu-latest` and publishes only `web/` through GitHub Pages.  This target builds the HTML, runs the Rust unit/CLI tests, and reuses the native debug scraper built and exercised by those tests to fetch menus.  It skips the separate release build because the scraper binary is not deployed; normal `make web` builds still use release mode.  It starts at 7:17 AM in `America/Los_Angeles` every Monday through Friday, automatically adjusting for daylight saving time.  GitHub may delay scheduled runs, and build time adds to the publication delay.  The workflow also supports manual runs through **Actions → Publish GitHub Pages → Run workflow**.

Enable deployment by selecting **GitHub Actions** under **Settings → Pages → Build and deployment → Source** and merging the workflow into the default branch.  Each successful deployment replaces the previous site at `https://MichaelSinz.github.io/WhatTheFood/`.  Build failures, fatal scraper errors, or a majority of linked locations failing prevent deployment, leaving the previous site unchanged; failures affecting at most half of the linked locations warn and allow deployment of a clearly marked partial snapshot.  Generated files are uploaded as a deployment artifact, not committed to the repository.

The build job has read-only repository access; only the deployment job receives `pages: write` and `id-token: write` permissions.  Deployments are serialized without canceling an in-progress run.  Menu providers must accept requests from GitHub-hosted Linux runners.

GitHub automatically disables scheduled workflows in public repositories after 60 days without repository activity.  Re-enable the workflow from the Actions tab if this happens.

## Developer checks

```sh
make check
# Optional Node.js/Playwright setup; never part of normal builds:
make setup-test
make test-web
# Include a real generated snapshot in browser verification:
FOOD_FINDER_WEB_DATA="$PWD/web/menus.js" make test-web
```

Every Makefile target that builds the Rust executable first runs its unit/CLI tests.  Browser tests are optional, use the root `package.json`/lockfile, and keep installed engines and fixtures under `.tmp`.  The default tests use synthetic menus.  Real-data browser checks and replay of separately supplied API captures (`FOOD_FINDER_REPLAY`) are opt-in.  Desktop browser emulation is not a substitute for checking actual phone keyboards.

Commit source, lockfiles, documentation, and the SVG; do not commit daily menus or generated HTML.  Keep dependencies and build commands portable between Linux and macOS.
