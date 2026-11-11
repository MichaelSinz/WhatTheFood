/**
 * What the Food - browser menu search and ordering handoff.
 *
 * Searches a generated menu snapshot without contacting the menu APIs.
 * Filters and frequent searches stay in browser storage, never on a server.
 */
"use strict";
setTimeout(() => {
	//==============================================================================
	// APPLICATION STATE: Menu data and browser-local preferences
	//==============================================================================

	const $ = (id) => document.getElementById(id);
	const fields = ["location", "vendor", "category", "name", "price"];
	const labels = {
		location: "Location",
		vendor: "Vendor",
		category: "Category",
		name: "Item",
		price: "Price",
	};
	const storageKeys = {
		disabled: "what-the-food.locations.v1",
		vendors: "what-the-food.vendors.v1",
		categories: "what-the-food.categories.v1",
		searches: "what-the-food.searches.v1",
	};
	const collator = new Intl.Collator(undefined, {
		numeric: true,
		sensitivity: "base",
	});
	const dayFormatter = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Los_Angeles",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const normalize = (value) =>
		String(value)
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase();
	const categoryText = (value) =>
		value.normalize("NFKC")
			.replace(/\s+/g, " ")
			.trim()
			.replace(/\s+\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|oz|ml|l)$/i, "");
	const categoryMatch = (value) =>
		normalize(categoryText(value))
			.replace(/[\u2018\u2019]/g, "'")
			.replace(/\s+(?:&|\+|and)\s+/g, " + ");
	const categoryAliases = new Map();
	const categoryLabels = new Map();
	// Exact category aliases, not broad spelling or singularization rules.
	for (const [label, ...aliases] of [
		["Entr\u00e9es", "Entr\u00e9e"],
		["\u00c0 la carte"],
		["Breakfast", "Breakfast - Available All Day", "Hot Breakfast", "Breakfast Sandwich"],
		["Chef's Table", "Chef Table"],
		["Coffee + Espresso", "Coffee", "Hot Coffee", "Espresso", "Espresso + Coffee",
			"Espresso Beverages", "Classic", "On Bar", "Specialty Coffee Series"],
		["Cold Drinks", "Cold Dinks"],
		["Himalaya", "Himalayan"],
		["Pizza", "Pizzas", "Pizza By The Slice", "Napoli", "Veloce Slices"],
		["Salads", "Signature Salads"],
		["Sandwiches", "Half Sandwiches", "Whole Sandwiches", "Signature Sandwiches", "Cuban Sandwiches"],
		["Sandwiches + More"],
		["Sides + Dessert"],
		["Small Plates", "Small Plate"],
		["Soups + Sides"],
		["Teriyaki", "Teriayki"],
		["Tea + Elixirs", "Tea + Elixers"],
	]) {
		const key = categoryMatch(label);
		categoryLabels.set(key, label);
		for (const name of [label, ...aliases])
			categoryAliases.set(categoryMatch(name), key);
	}
	const categoryKey = (value) => {
		const key = categoryMatch(value);
		return categoryAliases.get(key) ?? key;
	};
	function registerCategory(value) {
		const key = categoryKey(value);
		if (!categoryLabels.has(key))
			categoryLabels.set(
				key,
				categoryText(value).replace(/\s+(?:&|\+|and)\s+/gi, " + "),
			);
		return key;
	}
	const campusDay = () => {
		const parts = Object.fromEntries(
			dayFormatter.formatToParts(new Date()).map((p) => [p.type, p.value]),
		);
		return `${parts.year}-${parts.month}-${parts.day}`;
	};
	let data = null,
		matches = [],
		rendered = 0,
		selectedItem = null;
	let preferences = {
		disabled: [],
		vendors: [],
		categories: [],
		searches: [],
		field: "location",
		ascending: true,
		query: "",
	};
	let storageKind = "localStorage";
	let filterMode = "locations";
	let filterOptions = { locations: [], vendors: [], categories: [] };
	let searchEdited = false;
	const categoryName = (item) => item.category.split(" / ").at(-1);
	const includedItem = (item) =>
		!preferences.vendors.includes(item.vendor) &&
		!preferences.categories.includes(categoryKey(categoryName(item)));
	const searchIdentity = (query) =>
		normalize(query)
			.replace(/[\u201c\u201d]/g, '"')
			.replace(/\s+/g, " ")
			.trim();
	const moneyFormats = new Map();
	function money(item) {
		if (!moneyFormats.has(item.currency))
			moneyFormats.set(
				item.currency,
				new Intl.NumberFormat(undefined, {
					style: "currency",
					currency: item.currency,
				}),
			);
		return moneyFormats.get(item.currency).format(Number(item.price));
	}

	//==============================================================================
	// BROWSER STORAGE: Save preferences with a session-only fallback
	//==============================================================================

	function storageWarning(message) {
		$("preferences-warning").textContent = message;
		$("preferences-warning").hidden = false;
	}
	function openStorage(kind) {
		try {
			const storage = window[kind];
			storage.setItem(storageKeys.disabled + ".probe", "1");
			storage.removeItem(storageKeys.disabled + ".probe");
			storageKind = kind;
			return storage;
		} catch (error) {
			console.warn(`${kind} is unavailable:`, error);
			return null;
		}
	}
	let preferenceStorage =
		openStorage("localStorage") || openStorage("sessionStorage");
	if (!preferenceStorage)
		storageWarning(
			"Filters and frequent searches cannot be saved in this browser. Changes last only until this page is closed or reloaded.",
		);
	else if (storageKind === "sessionStorage")
		storageWarning(
			"Local storage is unavailable. Filters and frequent searches will be saved for this browser session only.",
		);
	for (const [field, key] of Object.entries(storageKeys)) {
		try {
			const saved = preferenceStorage && preferenceStorage.getItem(key);
			if (saved != null) {
				const value = JSON.parse(saved);
				const valid =
					Array.isArray(value) &&
					(field === "searches"
						? value.every((entry) =>
							entry && typeof entry.query === "string" && entry.query.trim() &&
							Number.isSafeInteger(entry.count) && entry.count > 0 &&
							Number.isSafeInteger(entry.lastUsed) && entry.lastUsed > 0)
						: value.every((id) => typeof id === "string"));
				if (!valid) throw new Error(`Invalid saved ${field}`);
				preferences[field] = field === "searches"
					? value.slice(0, 50)
					: field === "categories"
						? [...new Set(value.map(registerCategory))]
						: value;
			}
		} catch (error) {
			storageWarning(
				"Some saved preferences could not be read. The affected filters or frequent searches have been reset.",
			);
			console.warn(`Unable to read ${key}:`, error);
		}
	}
	function savePreferences() {
		if (!preferenceStorage) return;
		try {
			for (const [field, key] of Object.entries(storageKeys)) {
				const value = field === "categories"
					? preferences.categories.map((id) => categoryLabels.get(id) ?? id)
					: preferences[field];
				preferenceStorage.setItem(key, JSON.stringify(value));
			}
		} catch (error) {
			console.warn("Unable to save browser preferences:", error);
			preferenceStorage =
				storageKind === "localStorage" ? openStorage("sessionStorage") : null;
			if (preferenceStorage) {
				storageWarning(
					"Local storage is unavailable. Filters and frequent searches will be saved for this browser session only.",
				);
				savePreferences();
			} else {
				storageWarning(
					"Filters and frequent searches cannot be saved in this browser. Changes last only until this page is closed or reloaded.",
				);
			}
		}
	}

	//==============================================================================
	// FREQUENT SEARCHES: Count completed edits, not keystrokes or repeated blur
	//==============================================================================

	function hideSearches() {
		$("search-history").hidden = true;
		$("query").setAttribute("aria-expanded", "false");
	}
	function rememberSearch() {
		if (!searchEdited) return;
		searchEdited = false;
		const query = preferences.query.replace(/\s+/g, " ").trim();
		if (!query.replace(/["\u201c\u201d]/g, "").trim()) return;
		const identity = searchIdentity(query);
		let entry = preferences.searches.find(
			(saved) => searchIdentity(saved.query) === identity,
		);
		const lastUsed =
			Math.max(0, ...preferences.searches.map((saved) => saved.lastUsed)) + 1;
		if (entry) {
			entry.query = query;
			entry.count++;
			entry.lastUsed = lastUsed;
		} else {
			entry = { query, count: 1, lastUsed };
			preferences.searches.push(entry);
		}
		// Retain a small candidate pool so new queries can become frequent searches.
		preferences.searches.sort((a, b) => b.lastUsed - a.lastUsed);
		preferences.searches = preferences.searches.slice(0, 50);
		savePreferences();
	}
	function showSearches() {
		const query = searchIdentity(preferences.query);
		const entries = [...preferences.searches]
			.sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed)
			.filter((entry) => searchIdentity(entry.query).includes(query))
			.slice(0, 6);
		const fragment = document.createDocumentFragment();
		for (const entry of entries) {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = entry.query;
			// Safari may blur the input before a tapped suggestion receives its click.
			button.addEventListener("mousedown", (event) => event.preventDefault());
			button.addEventListener("click", () => {
				$("query").value = entry.query;
				$("query").dispatchEvent(new Event("input", { bubbles: true }));
				rememberSearch();
				$("query").focus({ preventScroll: true });
				hideSearches();
			});
			fragment.append(button);
		}
		$("search-suggestions").replaceChildren(fragment);
		$("search-history").hidden = !entries.length;
		$("query").setAttribute("aria-expanded", String(!!entries.length));
	}
	function orderingURL(item) {
		const url = new URL(item.orderingURL);
		if (
			url.protocol !== "https:" ||
			!url.hostname.endsWith(".buy-ondemand.com") ||
			url.username ||
			url.password ||
			url.port
		) {
			throw new Error("Unsupported ordering URL");
		}
		return url;
	}

	/**
	 * Validate the entire snapshot before indexing or displaying any menu items.
	 * Ordering destinations, dated hours, and completeness must be consistent.
	 */
	function validate(value) {
		if (
			!value ||
			![1, 2].includes(value.schemaVersion) ||
			!/^\d{4}-\d{2}-\d{2}$/.test(value.campusDay) ||
			value.timeZone !== "America/Los_Angeles" ||
			!Number.isFinite(Date.parse(value.generatedAt)) ||
			typeof value.complete !== "boolean" ||
			!Array.isArray(value.locations)
		)
			throw new Error("Unsupported menu data format");
		const locationIDs = new Set();
		for (const location of value.locations) {
			if (
				!location ||
				typeof location.id !== "string" ||
				!location.id ||
				locationIDs.has(location.id) ||
				typeof location.name !== "string" ||
				!(value.schemaVersion === 2
					? ["ok", "partial", "error", "no_ordering_url"]
					: ["ok", "error", "no_ordering_url"]).includes(location.status) ||
				!Array.isArray(location.items) ||
				!Array.isArray(location.notices) ||
				!location.notices.every((n) => typeof n === "string") ||
				(["error", "partial"].includes(location.status) && typeof location.error !== "string") ||
				(!["ok", "partial"].includes(location.status) && location.items.length) ||
				(location.status === "partial" && !location.items.length)
			)
				throw new Error("Invalid location data");
			locationIDs.add(location.id);
			for (const item of location.items) {
				if (
					!item ||
					![
						"id",
						"location",
						"vendor",
						"menu",
						"category",
						"name",
						"description",
						"price",
						"currency",
						"orderingURL",
					].every((key) => typeof item[key] === "string") ||
					!/^-?\d+(?:\.\d+)?$/.test(item.price) ||
					!Number.isFinite(Number(item.price)) ||
					!/^[A-Z]{3}$/.test(item.currency)
				)
					throw new Error("Invalid menu item");
				orderingURL(item);
				if (
					item.orderingCategoryPath != null &&
					(!Array.isArray(item.orderingCategoryPath) ||
						item.orderingCategoryPath.length > 2 ||
						!item.orderingCategoryPath.every(
							(id) => typeof id === "string" && id.length > 0,
						))
				) {
					throw new Error("Invalid ordering category path");
				}
				if (item.vendorOpeningWindow != null) {
					const { start, end } = item.vendorOpeningWindow;
					if (
						!Number.isFinite(Date.parse(start)) ||
						!Number.isFinite(Date.parse(end)) ||
						Date.parse(end) <= Date.parse(start)
					) {
						throw new Error("Invalid vendor hours");
					}
				}
			}
		}
		if (value.complete !== !value.locations.some((l) => ["error", "partial"].includes(l.status)))
			throw new Error("Inconsistent menu completeness");
		return value;
	}

	//==============================================================================
	// SNAPSHOT DISPLAY: Render provider text as text, never as HTML
	//==============================================================================

	function showDialog(id) {
		$(id).showModal();
	}
	for (const button of document.querySelectorAll("[data-close]"))
		button.addEventListener("click", () => button.closest("dialog").close());
	for (const dialog of document.querySelectorAll("dialog")) {
		dialog.addEventListener("click", (event) => {
			if (event.target === dialog) {
				const box = dialog.getBoundingClientRect();
				if (
					event.clientX < box.left ||
					event.clientX > box.right ||
					event.clientY < box.top ||
					event.clientY > box.bottom
				)
					dialog.close();
			}
		});
	}
	$("about-button").onclick = () => showDialog("about-dialog");
	$("about-locations-button").onclick = () => {
		$("about-dialog").close();
		showDialog("locations-dialog");
	};
	$("locations-button").onclick =
		$("data-status").onclick =
		$("empty-locations").onclick =
			() => showDialog("locations-dialog");
	$("reload-button").onclick = () => window.location.reload();
	$("detail-dialog").addEventListener("close", () => {
		selectedItem = null;
	});

	const filterPreference = () =>
		filterMode === "locations" ? "disabled" : filterMode;
	function updateAllLocations() {
		const locations = filterOptions[filterMode].filter(
			(location) => location.status !== "no_ordering_url",
		);
		const enabled = locations.filter(
			(location) => !preferences[filterPreference()].includes(location.id),
		).length;
		$("all-locations").disabled = !locations.length;
		$("all-locations").checked =
			locations.length > 0 && enabled === locations.length;
		$("all-locations").indeterminate = enabled > 0 && enabled < locations.length;
	}
	$("all-locations").addEventListener("change", () => {
		const ids = new Set(
			filterOptions[filterMode]
				.filter((location) => location.status !== "no_ordering_url")
				.map((location) => location.id),
		);
		const field = filterPreference();
		preferences[field] = preferences[field].filter((id) => !ids.has(id));
		if (!$("all-locations").checked) preferences[field].push(...ids);
		savePreferences();
		renderLocations();
		render();
	});
	for (const mode of document.querySelectorAll('input[name="filter-mode"]'))
		mode.addEventListener("change", () => {
			filterMode = mode.value;
			renderLocations();
		});

	function renderLocations() {
		if (!data) return;
		const fragment = document.createDocumentFragment();
		const field = filterPreference();
		$("filter-description").textContent =
			filterMode === "categories"
				? "Choose category names to show across all vendors and locations."
				: `Choose which ${filterMode} to show.`;
		for (const location of filterOptions[filterMode]) {
			const row = document.createElement("div");
			row.className = "location-row";
			const label = document.createElement(
				location.status === "no_ordering_url" ? "div" : "label",
			);
			label.className = "location-label";
			const name = document.createElement("span");
			name.textContent = location.name;
			label.append(name);
			const disabled = preferences[field].includes(location.id);
			if (location.status !== "no_ordering_url") {
				const toggle = document.createElement("input");
				toggle.type = "checkbox";
				toggle.checked = !disabled;
				toggle.setAttribute("role", "switch");
				toggle.addEventListener("change", () => {
					preferences[field] = preferences[field].filter(
						(id) => id !== location.id,
					);
					if (!toggle.checked) preferences[field].push(location.id);
					updateAllLocations();
					savePreferences();
					render();
				});
				label.append(toggle);
			}
			row.append(label);
			if (filterMode === "locations") {
				const status = document.createElement("p");
				status.className = `location-status${["error", "partial"].includes(location.status) ? " failed" : ""}`;
				status.textContent =
					location.status === "no_ordering_url"
						? "No ordering link in the directory."
						: location.status === "error"
							? `Fetch failed: ${location.error}`
							: `${location.items.length.toLocaleString()} saved items${location.status === "partial" ? `\nPartial menu: ${location.error}` : ""}${location.notices.length ? `\n${location.notices.join("\n")}` : ""}`;
				row.append(status);
			} else if (location.absent) {
				const status = document.createElement("p");
				status.className = "location-status";
				status.textContent = "Not in this snapshot.";
				row.append(status);
			}
			fragment.append(row);
		}
		$("location-list").replaceChildren(fragment);
		updateAllLocations();
		$("generated-at").textContent =
			`Menus for ${data.campusDay}. Generated ${new Date(data.generatedAt).toLocaleString()}.`;
	}
	function updateSortControls() {
		$("sort-field").value = preferences.field;
		$("compact-sort-order").value =
			`${preferences.field}:${preferences.ascending ? "asc" : "desc"}`;
		const direction = preferences.ascending ? "ascending" : "descending";
		$("sort-direction").textContent = preferences.ascending
			? "\u2191"
			: "\u2193";
		$("sort-direction").setAttribute(
			"aria-label",
			`Sort ${direction}; activate to reverse`,
		);
		$("sort-direction").title = `Sort ${direction}`;
		for (const header of document.querySelectorAll("th[data-field]")) {
			const active = header.dataset.field === preferences.field;
			header.setAttribute("aria-sort", active ? direction : "none");
			header.firstElementChild.textContent =
				labels[header.dataset.field] +
				(active ? (preferences.ascending ? " \u2191" : " \u2193") : "");
		}
	}
	function compare(a, b) {
		const field = preferences.field;
		const order =
			field === "price"
				? Number(a.price) - Number(b.price)
				: collator.compare(a[field], b[field]);
		if (order) return preferences.ascending ? order : -order;
		for (const key of ["location", "vendor", "name", "category"]) {
			if (key !== field) {
				const tie = collator.compare(a[key], b[key]);
				if (tie) return tie;
			}
		}
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	}
	function updateStatus(enabled, total) {
		$("summary").textContent =
			`${matches.length.toLocaleString()} ${matches.length === 1 ? "match" : "matches"} / ${total.toLocaleString()} items`;
		const failed = enabled.filter((l) => l.status === "error").length;
		const partial = enabled.filter((l) => l.status === "partial").length;
		const notices = enabled.reduce((count, l) => count + l.notices.length, 0);
		const stale = data.campusDay !== campusDay();
		$("data-status").textContent =
			`${data.campusDay} \u00b7 ${enabled.length} locations enabled${failed ? ` \u00b7 ${failed} failed` : ""}${partial ? ` \u00b7 ${partial} partial` : ""}${notices ? ` \u00b7 ${notices} notices` : ""}`;
		for (const field of ["vendors", "categories"]) {
			const hidden = filterOptions[field].filter(
				(option) => preferences[field].includes(option.id),
			).length;
			if (hidden)
				$("data-status").textContent += ` \u00b7 ${hidden} ${field} hidden`;
		}
		$("locations-button").title = `Filters: ${$("data-status").textContent}`;
		const warnings = [];
		if (stale)
			warnings.push(
				`These menus are for ${data.campusDay}, not today (${campusDay()}). Run the scraper to get today's menus.`,
			);
		if (!data.complete) {
			const allFailed = data.locations.filter(
				(l) => l.status === "error",
			).length;
			const allPartial = data.locations.filter(
				(l) => l.status === "partial",
			).length;
			const problems = [];
			if (allFailed)
				problems.push(`${allFailed} ${allFailed === 1 ? "location failed" : "locations failed"} to load`);
			if (allPartial)
				problems.push(`${allPartial} ${allPartial === 1 ? "location has" : "locations have"} incomplete menus`);
			warnings.push(
				`Partial snapshot: ${problems.join("; ")}. See Filters for details.`,
			);
		}
		$("data-warning").textContent = warnings.join("  ");
		$("data-warning").hidden = warnings.length === 0;
	}
	function appendRows() {
		const end = Math.min(rendered + 100, matches.length);
		const fragment = document.createDocumentFragment();
		for (let index = rendered; index < end; index++) {
			const item = matches[index],
				row = document.createElement("tr");
			row.dataset.index = String(index);
			for (const key of fields) {
				const cell = document.createElement("td");
				if (key === "name") {
					const button = document.createElement("button");
					button.className = "item-button";
					button.textContent = item.name;
					cell.append(button);
				} else {
					cell.textContent = key === "price" ? money(item) : item[key];
				}
				if (key === "price") cell.className = "price";
				row.append(cell);
			}
			fragment.append(row);
		}
		rendered = end;
		$("menu-rows").append(fragment);
		$("more").hidden = rendered >= matches.length;
		$("more").textContent =
			`Show more (${rendered.toLocaleString()} of ${matches.length.toLocaleString()})`;
	}
	function render() {
		if (!data) return;
		const enabled = data.locations.filter(
			(l) =>
				l.status !== "no_ordering_url" && !preferences.disabled.includes(l.id),
		);
		const items = enabled.flatMap((l) => l.items).filter(includedItem);
		// Every term must match; a quoted phrase cannot span multiple item fields.
		const terms = Array.from(
			preferences.query
				.replace(/[\u201c\u201d]/g, '"')
				.matchAll(/"([^"]*)"?|([^\s"]+)/g),
			(match) =>
				normalize(match[1] ?? match[2])
					.replace(/\s+/g, " ")
					.trim(),
		).filter(Boolean);
		matches = items
			.filter((item) =>
				terms.every((term) =>
					item.searchFields.some((field) => field.includes(term)),
				),
			)
			.sort(compare);
		updateSortControls();
		updateStatus(enabled, items.length);
		$("results").scrollTop = 0;
		rendered = 0;
		$("menu-rows").replaceChildren();
		$("menu-table").hidden = !matches.length;
		$("empty").hidden = !!matches.length;
		$("empty-locations").hidden = false;
		if (!matches.length) {
			$("empty-title").textContent = !enabled.length
				? "No locations enabled"
				: preferences.query.trim()
					? "No matching items"
					: preferences.vendors.length || preferences.categories.length
						? "No menus match your filters"
						: "No menus available";
			$("empty-message").textContent = !enabled.length
				? "Enable locations to browse their saved menus."
				: preferences.query.trim()
					? "Try another search or adjust your filters."
					: "Check Filters for disabled choices, closed sites, unavailable menus, or fetch errors.";
		}
		appendRows();
	}
	$("query").value = preferences.query;
	$("clear-query").disabled = !$("query").value;
	$("query").addEventListener("input", () => {
		$("clear-query").disabled = !$("query").value;
		preferences.query = $("query").value;
		searchEdited = true;
		render();
		if (document.activeElement === $("query")) showSearches();
	});
	$("query").addEventListener("focus", showSearches);
	$("query").addEventListener("blur", (event) => {
		if (!event.relatedTarget || !event.relatedTarget.closest("#search-history"))
			rememberSearch();
	});
	$("query").closest(".search").addEventListener("focusout", (event) => {
		if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget)) {
			rememberSearch();
			hideSearches();
		}
	});
	$("query").closest(".search").addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			hideSearches();
			$("query").focus({ preventScroll: true });
			hideSearches();
			event.preventDefault();
		} else if (event.key === "ArrowDown" && event.target === $("query")) {
			showSearches();
			const first = $("search-suggestions").querySelector("button");
			if (first) {
				first.focus();
				event.preventDefault();
			}
		} else if (event.key === "Enter" && event.target === $("query")) {
			rememberSearch();
			hideSearches();
			event.preventDefault();
		}
	});
	$("clear-query").onclick = () => {
		$("query").value = "";
		$("query").dispatchEvent(new Event("input", { bubbles: true }));
		$("query").focus({ preventScroll: true });
	};
	$("sort-field").addEventListener("change", () => {
		preferences.field = $("sort-field").value;
		render();
	});
	$("compact-sort-order").addEventListener("change", () => {
		const [field, direction] = $("compact-sort-order").value.split(":");
		preferences.field = field;
		preferences.ascending = direction === "asc";
		render();
	});
	$("sort-direction").onclick = () => {
		preferences.ascending = !preferences.ascending;
		render();
	};
	for (const header of document.querySelectorAll("th[data-field]")) {
		header.firstElementChild.onclick = () => {
			if (preferences.field === header.dataset.field)
				preferences.ascending = !preferences.ascending;
			else {
				preferences.field = header.dataset.field;
				preferences.ascending = true;
			}
			render();
		};
	}
	$("more").onclick = appendRows;
	if ("IntersectionObserver" in window) {
		new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting) && !$("more").hidden)
					appendRows();
			},
			{ root: $("results"), rootMargin: "200px" },
		).observe($("more"));
	}
	//==============================================================================
	// ORDERING HANDOFF: Direct links are valid only during dated vendor hours
	//==============================================================================

	/**
	 * Use a vendor/category link while open, otherwise offer pickup-time selection.
	 * Re-check against the browser clock so a previously opened dialog stays valid.
	 */
	function updateOrdering() {
		if (!selectedItem) return;
		const item = selectedItem,
			url = orderingURL(item),
			parts = item.id.split("::");
		const window = item.vendorOpeningWindow;
		const instant = Date.now();
		const isOpen =
			data.campusDay === campusDay() &&
			window &&
			Date.parse(window.start) <= instant &&
			instant < Date.parse(window.end);
		const canLink =
			parts.length >= 7 &&
			parts[0] === url.hostname &&
			parts.slice(1, 4).every(Boolean);
		const pickup = new URL(url.origin + "/");
		if (canLink) pickup.searchParams.set("displayProfileId", parts[2]);
		else pickup.href = url.href;
		const direct = new URL(pickup);
		if (isOpen && canLink) {
			direct.pathname =
				"/menu/" +
				[...parts.slice(1, 4), ...(item.orderingCategoryPath || [])]
					.map(encodeURIComponent)
					.join("/");
			direct.search = "";
			direct.hash = "";
		}
		const opensVendor = !!(isOpen && canLink);
		$("ordering-link").href = opensVendor ? direct.href : pickup.href;
		$("ordering-link").textContent =
			(opensVendor ? "Open Ordering Website" : "Choose Pickup Time") +
			" \u2197";
		$("pickup-link").href = pickup.href;
		$("pickup-link").hidden = !opensVendor;
		$("ordering-caption").textContent = opensVendor
			? `Open ${item.vendor}'s menu, or choose another pickup time.`
			: `Choose a pickup time on the website, then select ${item.vendor}. Menu availability may have changed since this snapshot.`;
	}
	$("menu-rows").addEventListener("click", (event) => {
		const row = event.target.closest("tr[data-index]");
		if (!row) return;
		rememberSearch();
		selectedItem = matches[Number(row.dataset.index)];
		for (const key of ["location", "vendor", "category", "description"])
			$("detail-" + key).textContent = selectedItem[key];
		$("detail-title").textContent = selectedItem.name;
		$("detail-price").textContent = money(selectedItem);
		updateOrdering();
		showDialog("detail-dialog");
	});
	// Re-evaluate the destination when clicked, not just when the detail view opened.
	$("ordering-link").addEventListener("click", updateOrdering);
	let lastDay = campusDay();
	function checkClock() {
		if (data && lastDay !== campusDay()) {
			lastDay = campusDay();
			const enabled = data.locations.filter(
				(l) =>
					l.status !== "no_ordering_url" &&
					!preferences.disabled.includes(l.id),
			);
			updateStatus(
				enabled,
				enabled.reduce((total, l) => total + l.items.filter(includedItem).length, 0),
			);
		}
		updateOrdering();
	}
	setInterval(checkClock, 1000);
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden) checkClock();
	});
	//==============================================================================
	// STARTUP: Validate and index the snapshot before dismissing the loading screen
	//==============================================================================

	try {
		if (typeof menuData === "undefined")
			throw new Error("menus.js is missing, blocked, or invalid");
		data = validate(menuData);
		const items = data.locations.flatMap((location) => location.items);
		const options = (values, excluded) => [...new Set([...values, ...excluded])]
			.sort(collator.compare)
			.map((name) => ({
				id: name,
				name: name || "(Uncategorized)",
				absent: !values.includes(name),
			}));
		filterOptions = {
			locations: data.locations,
			vendors: options(items.map((item) => item.vendor), preferences.vendors),
			categories: options(
				items.map((item) => registerCategory(categoryName(item))),
				preferences.categories,
			).map((option) => ({
				...option,
				name: categoryLabels.get(option.id) || "(Uncategorized)",
			})),
		};
		for (const location of data.locations)
			for (const item of location.items) {
				item.searchFields = [
					item.location,
					item.vendor,
					item.menu,
					item.category,
					item.name,
					item.description,
					item.price,
					item.currency,
				].map((field) => normalize(field).replace(/\s+/g, " ").trim());
			}
		renderLocations();
		render();
	} catch (error) {
		data = null;
		$("summary").textContent = "Menu data unavailable";
		$("data-status").textContent = "About and settings remain available";
		$("empty-title").textContent = "Unable to load menus";
		$("empty-message").textContent =
			`${error.message}. Place the Rust-generated menus.js beside this HTML file, then reload.`;
		$("empty").hidden = false;
		$("menu-table").hidden = true;
		$("more").hidden = true;
		$("generated-at").textContent = "No valid menu snapshot is loaded.";
		console.error("Unable to load menu data:", error);
	}
	updateSortControls();
	$("loading-screen").hidden = true;
}, 50);
