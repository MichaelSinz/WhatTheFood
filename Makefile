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

.PHONY: all food-finder web quick-web html menus test-rust check setup-test test-web test clean help

all: web

food-finder: test-rust
	$(CARGO) build --manifest-path rust/Cargo.toml --release --locked $(TARGET_ARG)

web: html menus

quick-web: html test-rust
	rust/target/debug/food-finder --urls "$(URLS)" --concurrency "$(CONCURRENCY)" --output web/menus.js

html: web/index.html

web/index.html: site/index.html WhatTheFood.svg
	mkdir -p web .tmp
	awk -v icon=WhatTheFood.svg '\
		/<!-- WHAT_THE_FOOD_ICON -->/ { \
			while ((status = (getline line < icon)) > 0) print line; \
			if (status < 0) exit 1; \
			close(icon); next; \
		} \
		{ print }' site/index.html > .tmp/index.html
	mv .tmp/index.html web/index.html

menus: food-finder
	$(FOOD_FINDER) --urls "$(URLS)" --concurrency "$(CONCURRENCY)" --output web/menus.js

test-rust:
	$(CARGO) test --manifest-path rust/Cargo.toml --locked

check: test-rust
	$(CARGO) fmt --manifest-path rust/Cargo.toml -- --check
	$(CARGO) clippy --manifest-path rust/Cargo.toml --all-targets --locked -- -D warnings

setup-test:
	$(NPM) ci
	$(NODE) node_modules/playwright/cli.js install chromium webkit

test-web: html
	$(NODE) --test tests/web.test.cjs

test: test-rust test-web

clean:
	$(CARGO) clean --manifest-path rust/Cargo.toml
	rm -f web/index.html .tmp/index.html

help:
	@printf '%s\n' \
		'What the Food - build with make on Linux or macOS' \
		'' \
		'Normal builds need Rust/Cargo (edition 2024), make, awk, and a C toolchain.' \
		'Only fetching menus needs access to the ordering websites.' \
		'Node.js 22+, npm, and Playwright are optional, for browser tests only.' \
		'' \
		'make / make web   Test Rust, build the release scraper, build HTML, fetch fresh menus' \
		'make quick-web    Build HTML, run Rust tests, fetch menus with the tested debug scraper' \
		'make food-finder  Run Rust tests and build rust/target/release/food-finder' \
		'make html         Build web/index.html without fetching menus or building Rust' \
		'make menus        Test/build the scraper and fetch fresh web/menus.js' \
		'make test-rust    Run offline Rust unit and CLI tests' \
		'make check        Run Rust tests, formatting checks, and Clippy' \
		'make setup-test   Install optional browser-test dependencies and browser engines' \
		'make test-web     Build HTML and run Chromium/WebKit tests (after setup-test)' \
		'make test         Run Rust and browser tests' \
		'make clean        Remove Rust build products and generated HTML; keep menus.js' \
		'make help         Show this help' \
		'' \
		'Overrides: URLS=locations.json CONCURRENCY=4 CARGO=cargo NODE=node NPM=npm' \
		'Cross-build: make food-finder TARGET=i686-unknown-linux-musl (needs target/toolchain)' \
		'Deploy only the contents of web/: index.html and menus.js.'
