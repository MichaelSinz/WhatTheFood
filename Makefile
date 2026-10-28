.DEFAULT_GOAL := all

CARGO ?= cargo
NODE ?= node
NPM ?= npm
URLS ?= locations.json
CONCURRENCY ?= 4
TARGET ?=
TARGET_ARG = $(if $(TARGET),--target $(TARGET))
FOOD_FINDER = rust/target/$(if $(TARGET),$(TARGET)/)release/food-finder
PLAYWRIGHT_BROWSERS_PATH ?= $(CURDIR)/.tmp/playwright
export PLAYWRIGHT_BROWSERS_PATH
export PATH := $(CURDIR)/.tmp/node-runtime/node_modules/.bin:$(PATH)

.PHONY: all food-finder web quick-web html menus test-rust check setup-test test-web test clean help

all: web

food-finder: test-rust
	$(CARGO) build --manifest-path rust/Cargo.toml --release --locked $(TARGET_ARG)

web: html menus

quick-web: html test-rust
	rust/target/debug/food-finder --urls "$(URLS)" --concurrency "$(CONCURRENCY)" --output web/menus.js

html: web/index.html web/wtf.css web/wtf.js web/WhatTheFood.svg web/apple-touch-icon.png

web/%: site/%
	mkdir -p web
	cp $< $@

web/WhatTheFood.svg: WhatTheFood.svg
	mkdir -p web
	cp $< $@

menus: food-finder
	$(FOOD_FINDER) --urls "$(URLS)" --concurrency "$(CONCURRENCY)" --output web/menus.js

test-rust:
	$(CARGO) test --manifest-path rust/Cargo.toml --locked

check: test-rust
	$(CARGO) fmt --manifest-path rust/Cargo.toml -- --check
	$(CARGO) clippy --manifest-path rust/Cargo.toml --all-targets --locked -- -D warnings

setup-test:
	@if ! $(NODE) -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22 ? 1 : 0)' 2>/dev/null; then \
		printf '%s\n' 'Installing local Node.js and npm for browser tests...'; \
		$(NPM) install --prefix .tmp/node-runtime --no-package-lock --no-save node@24 npm@11; \
	fi

	env $(NPM) ci
	env $(NODE) node_modules/playwright/cli.js install chromium webkit

test-web: html
	env $(NODE) --test tests/web.test.cjs

test: test-rust test-web

clean:
	$(CARGO) clean --manifest-path rust/Cargo.toml
	rm -f web/index.html web/wtf.css web/wtf.js web/WhatTheFood.svg web/apple-touch-icon.png .tmp/index.html

help:
	@printf '%s\n' \
		'What the Food - build with make on Linux or macOS' \
		'' \
		'Normal builds need Rust/Cargo (edition 2024), make, and a C toolchain.' \
		'Only fetching menus needs access to the ordering websites.' \
		'Node.js, npm, and Playwright are optional, for browser tests only.' \
		'With working Node.js/npm, setup-test installs a local runtime if Node.js is older than 22.' \
		'' \
		'make / make web   Test Rust, build the release scraper, copy site assets, fetch fresh menus' \
		'make quick-web    Copy site assets, run Rust tests, fetch menus with the tested debug scraper' \
		'make food-finder  Run Rust tests and build rust/target/release/food-finder' \
		'make html         Copy HTML, CSS, JavaScript, and icons without fetching menus or building Rust' \
		'make menus        Test/build the scraper and fetch fresh web/menus.js' \
		'make test-rust    Run offline Rust unit and CLI tests' \
		'make check        Run Rust tests, formatting checks, and Clippy' \
		'make setup-test   Set up an optional local runtime, browser-test dependencies, and engines' \
		'make test-web     Build HTML and run Chromium/WebKit tests (after setup-test)' \
		'make test         Run Rust and browser tests' \
		'make clean        Remove Rust build products and copied site assets; keep menus.js' \
		'make help         Show this help' \
		'' \
		'Overrides: URLS=locations.json CONCURRENCY=4 CARGO=cargo NODE=node NPM=npm' \
		'Cross-build: make food-finder TARGET=i686-unknown-linux-musl (needs target/toolchain)' \
		'Deploy only the contents of web/: index.html, wtf.css, wtf.js, menus.js, WhatTheFood.svg, apple-touch-icon.png.'
