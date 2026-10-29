/**
 * What the Food - browser menu search and ordering handoff.
 *
 * Searches a generated menu snapshot without contacting the menu APIs.
 * Only location choices are persisted; search and sorting stay in memory.
 */
"use strict";
(() => {
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
	const storageKey = "what-the-food.locations.v1";
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
		field: "location",
		ascending: true,
		query: "",
	};
	let storageKind = "localStorage";
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
	// LOCATION STORAGE: Probe browser storage and fall back without blocking menus
	//==============================================================================

	function storageWarning(message) {
		$("preferences-warning").textContent = message;
		$("preferences-warning").hidden = false;
	}
	function openStorage(kind) {
		try {
			const storage = window[kind];
			storage.setItem(storageKey + ".probe", "1");
			storage.removeItem(storageKey + ".probe");
			storageKind = kind;
			return storage;
		} catch (error) {
			console.warn(`${kind} is unavailable:`, error);
			return null;
		}
	}
	let locationStorage =
		openStorage("localStorage") || openStorage("sessionStorage");
	if (!locationStorage)
		storageWarning(
			"Location choices cannot be saved in this browser. Changes last only until this page is closed or reloaded.",
		);
	else if (storageKind === "sessionStorage")
		storageWarning(
			"Local storage is unavailable. Location choices will be saved for this browser session only.",
		);
	try {
		const saved = locationStorage && locationStorage.getItem(storageKey);
		if (saved !== null) {
			const disabled = JSON.parse(saved);
			if (
				!Array.isArray(disabled) ||
				!disabled.every((id) => typeof id === "string")
			) {
				throw new Error("Invalid saved location choices");
			}
			preferences.disabled = disabled;
		}
	} catch (error) {
		storageWarning(
			"Saved location choices could not be read. All locations are enabled for this session.",
		);
		console.warn("Unable to read location choices:", error);
	}
	function saveLocations() {
		if (!locationStorage) return;
		try {
			locationStorage.setItem(storageKey, JSON.stringify(preferences.disabled));
		} catch (error) {
			console.warn("Unable to save location choices:", error);
			locationStorage =
				storageKind === "localStorage" ? openStorage("sessionStorage") : null;
			if (locationStorage) {
				storageWarning(
					"Local storage is unavailable. Location choices will be saved for this browser session only.",
				);
				saveLocations();
			} else {
				storageWarning(
					"Location choices cannot be saved in this browser. Changes last only until this page is closed or reloaded.",
				);
			}
		}
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
			value.schemaVersion !== 1 ||
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
				!["ok", "error", "no_ordering_url"].includes(location.status) ||
				!Array.isArray(location.items) ||
				!Array.isArray(location.notices) ||
				!location.notices.every((n) => typeof n === "string") ||
				(location.status === "error" && typeof location.error !== "string") ||
				(location.status !== "ok" && location.items.length)
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
		if (value.complete !== !value.locations.some((l) => l.status === "error"))
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

	function updateAllLocations() {
		const locations = data.locations.filter(
			(location) => location.status !== "no_ordering_url",
		);
		const enabled = locations.filter(
			(location) => !preferences.disabled.includes(location.id),
		).length;
		$("all-locations").disabled = !locations.length;
		$("all-locations").checked =
			locations.length > 0 && enabled === locations.length;
		$("all-locations").indeterminate = enabled > 0 && enabled < locations.length;
	}
	$("all-locations").addEventListener("change", () => {
		const ids = new Set(
			data.locations
				.filter((location) => location.status !== "no_ordering_url")
				.map((location) => location.id),
		);
		preferences.disabled = preferences.disabled.filter((id) => !ids.has(id));
		if (!$("all-locations").checked) preferences.disabled.push(...ids);
		saveLocations();
		renderLocations();
		render();
	});

	function renderLocations() {
		const fragment = document.createDocumentFragment();
		for (const location of data.locations) {
			const row = document.createElement("div");
			row.className = "location-row";
			const label = document.createElement(
				location.status === "no_ordering_url" ? "div" : "label",
			);
			label.className = "location-label";
			const name = document.createElement("span");
			name.textContent = location.name;
			label.append(name);
			const disabled = preferences.disabled.includes(location.id);
			if (location.status !== "no_ordering_url") {
				const toggle = document.createElement("input");
				toggle.type = "checkbox";
				toggle.checked = !disabled;
				toggle.setAttribute("role", "switch");
				toggle.addEventListener("change", () => {
					preferences.disabled = preferences.disabled.filter(
						(id) => id !== location.id,
					);
					if (!toggle.checked) preferences.disabled.push(location.id);
					updateAllLocations();
					saveLocations();
					render();
				});
				label.append(toggle);
			}
			const status = document.createElement("p");
			status.className = `location-status${location.status === "error" ? " failed" : ""}`;
			status.textContent =
				location.status === "no_ordering_url"
					? "No ordering link in the directory."
					: location.status === "error"
						? `Fetch failed: ${location.error}`
						: `${location.items.length.toLocaleString()} saved items${location.notices.length ? `\n${location.notices.join("\n")}` : ""}`;
			row.append(label, status);
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
		const notices = enabled.reduce((count, l) => count + l.notices.length, 0);
		const stale = data.campusDay !== campusDay();
		$("data-status").textContent =
			`${data.campusDay} \u00b7 ${enabled.length} locations enabled${failed ? ` \u00b7 ${failed} failed` : ""}${notices ? ` \u00b7 ${notices} notices` : ""}`;
		$("locations-button").title = `${enabled.length} locations enabled`;
		const warnings = [];
		if (stale)
			warnings.push(
				`These menus are for ${data.campusDay}, not today (${campusDay()}). Run the scraper to get today's menus.`,
			);
		if (!data.complete) {
			const allFailed = data.locations.filter(
				(l) => l.status === "error",
			).length;
			warnings.push(
				`Partial snapshot: ${allFailed} ${allFailed === 1 ? "location failed" : "locations failed"} to load. See Locations for details.`,
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
		const items = enabled.flatMap((l) => l.items);
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
					: "No menus available";
			$("empty-message").textContent = !enabled.length
				? "Enable locations to browse their saved menus."
				: preferences.query.trim()
					? "Try another search or enable more locations."
					: "Check Locations for closed sites, unavailable menus, or fetch errors.";
		}
		appendRows();
	}
	$("query").value = preferences.query;
	$("clear-query").disabled = !$("query").value;
	$("query").addEventListener("input", () => {
		$("clear-query").disabled = !$("query").value;
		preferences.query = $("query").value;
		render();
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
				enabled.reduce((total, l) => total + l.items.length, 0),
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
})();
