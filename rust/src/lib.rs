//! Fetch campus menu snapshots for the standalone What the Food page.
//!
//! # Data flow
//!
//! [`fetch_all`] validates location identities, creates an independent anonymous
//! session per linked location, and fetches today's scheduled menus concurrently.
//! The provider hierarchy is tenant -> store -> concept (vendor) -> menu ->
//! category -> item.  Raw responses stay internal; [`Snapshot`] is the versioned
//! browser-facing contract consumed by `site/index.html`.
//!
//! # Failure and publication
//!
//! A failed location is recorded in a partial snapshot rather than discarding
//! other locations' menus.  Invalid identities, invalid concurrency, and runs
//! crossing campus midnight return errors instead of a publishable snapshot.
//! [`write_script`] atomically replaces a named file; [`write_script_to`] emits
//! the same script to a writer without a file-replacement guarantee.
//!
//! There is no request/menu cache, and credentials never enter the snapshot.
//! See `project.md` for the ordering protocol and supported scheduling behavior.

use anyhow::{Context, Result, bail, ensure};
use chrono::{DateTime, SecondsFormat, TimeZone, Timelike, Utc};
use chrono_tz::{Tz, US::Pacific};
use futures::{StreamExt, stream};
use reqwest::{Client, Url, header};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashSet, io::Write, path::Path, str::FromStr, time::Duration};

/// Runtime catalog entry; a missing URL preserves an unlinked directory entry.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Location {
    /// Display name used for location selection and menu results.
    pub name: String,
    /// Provider HTTPS origin, or `None` when no ordering site is linked.
    pub url: Option<String>,
}

/// Versioned menu envelope shared with the browser's data validator.
///
/// Serialized field names and status values form a deployment contract.
/// Incompatible changes require coordinating the schema version and page.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    schema_version: u32,
    campus_day: String,
    time_zone: &'static str,
    started_at: DateTime<Utc>,
    generated_at: DateTime<Utc>,
    /// False when any linked location failed; closed/unlinked locations are not failures.
    pub complete: bool,
    /// Results in catalog order, regardless of concurrent completion order.
    pub locations: Vec<LocationResult>,
}

impl Snapshot {
    /// Whether more than half of the linked locations failed to fetch.
    ///
    /// Unlinked locations are excluded; successful empty/closed menus count as
    /// successes regardless of item count.
    pub fn has_majority_failures(&self) -> bool {
        let linked = self
            .locations
            .iter()
            .filter(|location| location.location.url.is_some())
            .count();
        let failed = self
            .locations
            .iter()
            .filter(|location| location.status == "error")
            .count();
        failed > linked / 2
    }
}

/// One location's menus, nonfatal notices, or explicit fetch failure.
///
/// Status is `ok`, `error`, or `no_ordering_url`.  Failed locations have no items;
/// notices describe legitimate unavailability or limited ordering-link metadata.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationResult {
    id: String,
    #[serde(flatten)]
    location: Location,
    status: &'static str,
    fetched_at: Option<DateTime<Utc>>,
    error: Option<String>,
    notices: Vec<String>,
    /// Guest-visible menu entries; empty for failed and unlinked locations.
    pub items: Vec<Item>,
}

/// Guest-facing item with a decimal-string base price and ordering metadata.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    // The browser splits this identity to recover host, store, profile, and vendor.
    // Keep that prefix in sync with its ordering-link construction.
    id: String,
    location: String,
    vendor: String,
    menu: String,
    category: String,
    name: String,
    description: String,
    // Decimal strings avoid introducing binary floating-point rounding in scraping.
    price: String,
    currency: String,
    #[serde(rename = "orderingURL")]
    ordering_url: String,
    vendor_opening_window: Option<OpeningWindow>,
    // Only the first menu and at most two category levels are browser-linkable.
    ordering_category_path: Option<Vec<String>>,
}

/// Dated UTC bounds used by the browser to decide whether direct ordering is valid.
#[derive(Clone, Debug, Serialize)]
struct OpeningWindow {
    start: DateTime<Utc>,
    end: DateTime<Utc>,
}

/// Accept provider fields represented as either JSON strings or numbers.
fn text(value: &Value, key: &str) -> Result<String> {
    match required(value, key)? {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        _ => bail!("Invalid {key}"),
    }
}

fn required<'a>(value: &'a Value, key: &str) -> Result<&'a Value> {
    value
        .get(key)
        .filter(|value| !value.is_null())
        .with_context(|| format!("Missing {key}"))
}

fn list(value: &Value) -> Result<&Vec<Value>> {
    value.as_array().context("Expected an array")
}

fn optional_list<'a>(value: &'a Value, key: &str) -> Result<&'a [Value]> {
    match value.get(key) {
        None => Ok(&[]),
        Some(value) => Ok(list(value)?),
    }
}

fn valid_base(location: &Location) -> Result<Url> {
    let base = Url::parse(location.url.as_deref().context("No ordering URL")?)?;
    ensure!(
        base.scheme() == "https"
            && base
                .host_str()
                .is_some_and(|host| host.ends_with(".buy-ondemand.com"))
            && base.username().is_empty()
            && base.password().is_none()
            && base.port().is_none()
            && base.path() == "/"
            && base.query().is_none()
            && base.fragment().is_none(),
        "Invalid ordering URL for {}",
        location.name
    );
    Ok(base)
}

/// Transport seam shared by live fetching and offline protocol replay tests.
///
/// Routes are relative to `api/`; a body selects POST, otherwise the request is GET.
trait MenuApi {
    async fn request(&mut self, route: &str, body: Option<Value>) -> Result<Value>;
}

/// Per-location session retaining its cookie jar, bearer token, and CSRF token.
///
/// Never share this session across hosts or serialize it into output data.
struct LiveApi {
    client: Client,
    base: Url,
    token: Option<String>,
    csrf: Option<String>,
}

impl LiveApi {
    fn new(base: Url) -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .use_rustls_tls()
                .cookie_store(true)
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(45))
                .build()?,
            base,
            token: None,
            csrf: None,
        })
    }
}

impl MenuApi for LiveApi {
    async fn request(&mut self, route: &str, body: Option<Value>) -> Result<Value> {
        let method = if body.is_some() { "POST" } else { "GET" };
        let request_context = format!("{method} {}api/{route}", self.base);
        async {
            let url = self.base.join(&format!("api/{route}"))?;
            let mut request = if let Some(body) = body {
                self.client.post(url).json(&body).header(
                    "csrf-token",
                    self.csrf.as_deref().context("Missing CSRF credential")?,
                )
            } else {
                self.client.get(url)
            };
            request = request.header(header::ACCEPT, "application/json").header(
                "client_time",
                Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            );
            if let Some(token) = &self.token {
                request = request.bearer_auth(token);
            }
            let response = request
                .send()
                .await
                .with_context(|| format!("Request failed: {route}"))?;
            ensure!(
                response.status().is_success(),
                "{route}: HTTP {}",
                response.status()
            );
            let token = if route == "login/anonymous" {
                Some(
                    response
                        .headers()
                        .get("gateway-token")
                        .or_else(|| response.headers().get("access-token"))
                        .context("Anonymous login returned no bearer token")?
                        .to_str()?
                        .to_owned(),
                )
            } else {
                None
            };
            let data: Value = response
                .json()
                .await
                .with_context(|| format!("Invalid JSON: {route}"))?;
            if token.is_some() {
                self.csrf = Some(text(&data, "csrfToken")?);
                self.token = token;
            }
            Ok(data)
        }
        .await
        .with_context(|| request_context)
    }
}

/// Translate the provider's legacy Pacific name to the campus IANA timezone.
fn zone(store: &Value) -> Result<Tz> {
    let name = text(store, "timeZone")?;
    Tz::from_str(if name == "PST8PDT" {
        "America/Los_Angeles"
    } else {
        &name
    })
    .context("Invalid store timezone")
}

fn minutes(value: &str) -> Result<u32> {
    let value = value.trim().to_ascii_uppercase();
    for format in ["%I:%M %p", "%H:%M"] {
        if let Ok(time) = chrono::NaiveTime::parse_from_str(&value, format) {
            return Ok(time.hour() * 60 + time.minute());
        }
    }
    bail!("Invalid clock time: {value}")
}

/// Choose today's earliest complete pickup interval at noon or later.
///
/// Honor the provider's buffer and align intervals to each opening window, not
/// midnight.  Midnight closing is the end of today; other overnight windows are
/// unsupported.  `None` means no remaining slot.
fn slot(store: &Value, scheduling: &Value, now: DateTime<Utc>) -> Result<Option<Value>> {
    let zone = zone(store)?;
    let interval: u32 = text(scheduling, "intervalTime")?.parse()?;
    let buffer: u32 = text(scheduling, "bufferTime")?.parse()?;
    ensure!(
        interval > 0 && interval <= 1440 && buffer <= 1440,
        "Invalid scheduling interval/buffer"
    );
    // Round the buffered instant up to a minute so a slot is never too early.
    let earliest = now
        + chrono::Duration::minutes(i64::from(buffer))
        + chrono::Duration::seconds(if now.second() > 0 || now.timestamp_subsec_nanos() > 0 {
            i64::from(60 - now.second())
        } else {
            0
        });
    let local = earliest.with_timezone(&zone);
    if local.date_naive() != now.with_timezone(&zone).date_naive() {
        return Ok(None);
    }
    let target = (12 * 60).max(local.hour() * 60 + local.minute());
    let Some(availability) = store.get("availableAt") else {
        return Ok(None);
    };
    let mut windows = optional_list(availability, "openWindowTimeFrames")?.to_vec();
    if windows.is_empty()
        && availability.get("opens").is_some()
        && availability.get("closes").is_some()
    {
        windows.push(availability.clone());
    }
    let mut candidates = Vec::new();
    for window in windows {
        let opens = minutes(&text(&window, "opens")?)?;
        let closes = minutes(&text(&window, "closes")?)?;
        let closes = if closes == 0 && opens > 0 {
            24 * 60
        } else {
            closes
        };
        ensure!(
            closes >= opens,
            "Overnight pickup windows are not supported"
        );
        candidates.extend(
            (opens..=closes)
                .step_by(interval as usize)
                .filter(|start| *start >= target && *start + interval <= closes),
        );
    }
    let clock = |n: u32| format!("{:02}:{:02}", n / 60 % 24, n % 60);
    Ok(candidates
        .into_iter()
        .min()
        .map(|start| json!({"startTime": clock(start), "endTime": clock(start + interval)})))
}

/// Convert today's vendor hours to unambiguous UTC instants for ordering links.
///
/// Missing hours disable direct linking.  Malformed, overnight, or DST-ambiguous
/// hours are reported to the caller rather than guessing an opening interval.
fn opening_window(
    concept: &Value,
    store: &Value,
    now: DateTime<Utc>,
) -> Result<Option<OpeningWindow>> {
    let Some(availability) = concept.get("availableAt") else {
        return Ok(None);
    };
    let (Some(open), Some(close)) = (availability.get("open"), availability.get("close")) else {
        return Ok(None);
    };
    let start = minutes(open.as_str().context("Invalid vendor opening time")?)?;
    let end = minutes(close.as_str().context("Invalid vendor closing time")?)?;
    ensure!(
        end > start,
        "Overnight or empty vendor opening windows are not supported"
    );
    let zone = zone(store)?;
    let day = now.with_timezone(&zone).date_naive();
    let instant = |minute| -> Result<DateTime<Utc>> {
        let time = day
            .and_hms_opt(minute / 60, minute % 60, 0)
            .context("Invalid opening time")?;
        Ok(zone
            .from_local_datetime(&time)
            .single()
            .context("Ambiguous opening time")?
            .with_timezone(&Utc))
    };
    Ok(Some(OpeningWindow {
        start: instant(start)?,
        end: instant(end)?,
    }))
}

/// Preserve the store's pricing configuration in menu and item lookup requests.
fn pricing_context(store: &Value) -> Result<Value> {
    let options = required(store, "displayOptions")?;
    let mut context = json!({
        "currencyUnit": required(options, "currency/currencyCode")?,
        "onDemandTerminalId": required(options, "onDemandTerminalId")?,
        "itemCountdown": store.get("itemCountdown").cloned().unwrap_or(json!({})),
    });
    for key in [
        "storePriceLevel",
        "profitCenterId",
        "show86edItems",
        "useIgPosApi",
    ] {
        context[key] = required(store, key)?.clone();
    }
    Ok(context)
}

// Encoding path components separately prevents discovered IDs from becoming API routes.
fn segment(value: &str) -> String {
    let mut url = Url::parse("https://example.invalid/").expect("constant URL");
    url.path_segments_mut()
        .expect("hierarchical URL")
        .push(value);
    url.path()[1..].to_owned()
}

/// Resolve one location's scheduled menus into items and nonfatal notices.
///
/// Concept metadata can include other weekdays, so menus must be resolved through
/// the scheduled menu endpoint before walking categories and fetching item IDs.
/// A protocol error fails the location; no partially gathered items escape.
async fn gather(
    api: &mut impl MenuApi,
    location: &Location,
    now: DateTime<Utc>,
) -> Result<(Vec<Item>, Vec<String>)> {
    let location_context = format!("Location {:?}", location.name);
    api.request("login/anonymous", None)
        .await
        .with_context(|| format!("{location_context}: starting anonymous session"))?;
    let config = api
        .request("config", None)
        .await
        .with_context(|| format!("{location_context}: fetching configuration"))?;
    let tenant = segment(
        &text(&config, "tenantId")
            .with_context(|| format!("{location_context}: reading configuration tenant ID"))?,
    );
    let scheduling = required(&config, "properties")
        .and_then(|properties| required(properties, "scheduledOrdering"))
        .with_context(|| format!("{location_context}: reading scheduling configuration"))?;
    let stores = api
        .request(&format!("sites/{tenant}"), None)
        .await
        .with_context(|| format!("{location_context}: fetching stores for tenant {tenant:?}"))?;
    let stores =
        list(&stores).with_context(|| format!("{location_context}: reading store list"))?;
    let mut items = Vec::new();
    let mut notices = Vec::new();
    if stores.is_empty() {
        notices.push("No stores were returned for this location.".into());
    }
    for (store_index, store) in stores.iter().enumerate() {
        let store_context = format!("{location_context}, store #{}", store_index + 1);
        if store["isShutdown"] == true {
            notices.push("This location is shut down.".into());
            continue;
        }
        ensure!(
            store["isScheduleOrderEnabled"] == true,
            "{store_context}: ASAP-only ordering is not supported"
        );
        let Some(slot) = slot(store, scheduling, now)
            .with_context(|| format!("{store_context}: selecting pickup interval"))?
        else {
            notices.push("No remaining pickup slots today.".into());
            continue;
        };
        let site = text(store, "id").with_context(|| store_context.clone())?;
        let store_context = format!("{store_context} (ID {site:?})");
        let profile = text(store, "displayProfileId").with_context(|| store_context.clone())?;
        let base = valid_base(location).with_context(|| store_context.clone())?;
        let mut ordering_url = base.clone();
        ordering_url
            .query_pairs_mut()
            .append_pair("displayProfileId", &profile);
        let root = format!("sites/{tenant}/{}", segment(&site));
        let concepts_route = format!("{root}/concepts/{}", segment(&profile));
        let concepts = api
            .request(
                &concepts_route,
                Some(json!({
                    "scheduleTime": slot, "scheduledDay": 0,
                })),
            )
            .await
            .with_context(|| format!("{store_context}: fetching vendors via {concepts_route}"))?;
        let concepts =
            list(&concepts).with_context(|| format!("{store_context}: reading vendor list"))?;
        if concepts.is_empty() {
            notices.push("No vendors available for today's pickup time.".into());
        }
        let context = pricing_context(store)
            .with_context(|| format!("{store_context}: reading pricing configuration"))?;
        for (vendor_index, concept) in concepts.iter().enumerate() {
            let vendor_context = format!("{store_context}, vendor #{}", vendor_index + 1);
            let vendor_id = text(concept, "id").with_context(|| vendor_context.clone())?;
            let vendor = text(concept, "name")
                .with_context(|| format!("{vendor_context} (ID {vendor_id:?})"))?
                .trim()
                .to_owned();
            let vendor_context = format!("{store_context}, vendor {vendor:?} (ID {vendor_id:?})");
            // Opening metadata controls the link, not whether the menu is usable.
            let opening = match opening_window(concept, store, now) {
                Ok(window) => window,
                Err(error) => {
                    notices.push(format!(
                        "{vendor_context}: {error:#}. Choose a pickup time on the ordering website."
                    ));
                    None
                }
            };
            let mut body = context.clone();
            body["menus"] = required(concept, "menus")
                .with_context(|| vendor_context.clone())?
                .clone();
            body["schedule"] = required(concept, "schedule")
                .with_context(|| vendor_context.clone())?
                .clone();
            body["scheduleTime"] = slot.clone();
            body["scheduledDay"] = json!(0);
            body["priceLevelConfig"] = concept
                .get("priceLevelConfig")
                .cloned()
                .unwrap_or(json!({}));
            let menus = api
                .request(
                    &format!("{concepts_route}/menus/{}", segment(&vendor_id)),
                    Some(body),
                )
                .await
                .with_context(|| format!("{vendor_context}: resolving scheduled menus"))?;
            let menus =
                list(&menus).with_context(|| format!("{vendor_context}: reading menu list"))?;
            for (menu_index, menu) in menus.iter().enumerate() {
                let menu_context = format!("{vendor_context}, menu #{}", menu_index + 1);
                if menu["isBoom"] == true {
                    let error = required(menu, "output").with_context(|| menu_context.clone())?;
                    let message = required(error, "payload")
                        .and_then(|payload| text(payload, "message"))
                        .with_context(|| menu_context.clone())?;
                    // The provider embeds unavailable-menu responses inside HTTP 200.
                    let status = text(error, "statusCode").with_context(|| menu_context.clone())?;
                    ensure!(
                        status == "410",
                        "{menu_context}: menu status {status}: {message}"
                    );
                    notices.push(format!("{vendor}: {message}"));
                    continue;
                }
                let menu_id = text(menu, "id").with_context(|| menu_context.clone())?;
                let menu_name = menu.get("name").and_then(Value::as_str).unwrap_or("");
                let menu_context = format!("{menu_context} (ID {menu_id:?}, name {menu_name:?})");
                // Reverse the stack inputs to preserve provider order during depth-first
                // traversal.  Display paths and supported website routes travel together.
                let mut pending: Vec<_> = required(menu, "categories")
                    .and_then(list)
                    .with_context(|| format!("{menu_context}: reading categories"))?
                    .iter()
                    .rev()
                    .map(|category| {
                        (
                            category,
                            Vec::<String>::new(),
                            (menu_index == 0).then(Vec::new),
                        )
                    })
                    .collect();
                while let Some((category, mut path, mut category_path)) = pending.pop() {
                    if category["isAvailableToGuests"] == false {
                        continue;
                    }
                    // Website routes use the first menu's returned IDs, at most two levels deep.
                    if let Some(route) = &mut category_path
                        && route.len() == path.len()
                        && route.len() < 2
                        && let Ok(id) = text(category, "id")
                        && !id.is_empty()
                    {
                        route.push(id);
                    }
                    path.push(
                        text(category, "name")
                            .with_context(|| format!("{menu_context}, category below {path:?}"))?,
                    );
                    let category_context =
                        format!("{menu_context}, category {:?}", path.join(" / "));
                    for child in optional_list(category, "subCategories")
                        .with_context(|| category_context.clone())?
                        .iter()
                        .rev()
                    {
                        pending.push((child, path.clone(), category_path.clone()));
                    }
                    let ids = optional_list(category, "items")
                        .with_context(|| category_context.clone())?;
                    let packages = optional_list(category, "packages")
                        .with_context(|| category_context.clone())?;
                    let entries = if ids.is_empty() { packages } else { ids };
                    if entries.is_empty() {
                        continue;
                    }
                    // Some menus already include full items.  Only unresolved IDs belong
                    // in the lookup request; mixing representations is a protocol error.
                    let resolved = if entries[0].is_object() {
                        ensure!(
                            entries.iter().all(Value::is_object),
                            "{category_context}: Mixed populated items and IDs"
                        );
                        entries.to_vec()
                    } else {
                        ensure!(
                            ids.iter().chain(packages).all(Value::is_string),
                            "{category_context}: Invalid item IDs"
                        );
                        let mut body = context.clone();
                        body["conceptId"] = json!(vendor_id);
                        body["isCategoryHasItems"] = json!(!ids.is_empty());
                        body["itemIds"] = json!(ids);
                        body["packageIds"] = json!(packages);
                        body["menuPriceLevel"] = category
                            .get("priceLevelConfig")
                            .cloned()
                            .unwrap_or(json!({}));
                        let response = api
                            .request(&format!("{root}/kiosk-items/get-items"), Some(body))
                            .await
                            .with_context(|| format!("{category_context}: fetching items"))?;
                        list(&response)
                            .with_context(|| format!("{category_context}: reading item list"))?
                            .clone()
                    };
                    for (item_index, item) in resolved.into_iter().enumerate() {
                        if item["isAvailableToGuests"] == false {
                            continue;
                        }
                        let item_context = format!("{category_context}, item #{}", item_index + 1);
                        let item_id = text(&item, "id").with_context(|| item_context.clone())?;
                        let item_context = format!("{item_context} (ID {item_id:?})");
                        let parsed_item = (|| -> Result<Item> {
                            let price = required(&item, "price")?;
                            let amount = Decimal::from_str_exact(&text(price, "amount")?)
                                .context("Invalid item price")?
                                .to_string();
                            let currency = text(price, "currencyUnit")?;
                            ensure!(
                                currency.len() == 3
                                    && currency.bytes().all(|c| c.is_ascii_uppercase()),
                                "Invalid currency"
                            );
                            let mut identity = vec![
                                base.host_str().context("Missing host")?.to_owned(),
                                site.clone(),
                                profile.clone(),
                                vendor_id.clone(),
                                menu_id.clone(),
                            ];
                            identity.extend(path.clone());
                            identity.push(item_id.clone());
                            Ok(Item {
                                id: identity.join("::"),
                                location: location.name.clone(),
                                vendor: vendor.clone(),
                                menu: menu_name.to_owned(),
                                category: path.join(" / "),
                                name: match item
                                    .get("displayText")
                                    .and_then(Value::as_str)
                                    .filter(|s| !s.is_empty())
                                {
                                    Some(name) => name.to_owned(),
                                    None => text(&item, "name")?,
                                },
                                description: item
                                    .get("description")
                                    .and_then(Value::as_str)
                                    .filter(|s| !s.is_empty())
                                    .or_else(|| item.get("longDescription").and_then(Value::as_str))
                                    .unwrap_or("")
                                    .to_owned(),
                                price: amount,
                                currency,
                                ordering_url: ordering_url.to_string(),
                                vendor_opening_window: opening.clone(),
                                ordering_category_path: category_path
                                    .clone()
                                    .filter(|route| !route.is_empty()),
                            })
                        })()
                        .with_context(|| item_context.clone())?;
                        items.push(parsed_item);
                    }
                }
            }
        }
    }
    if items.is_empty() && notices.is_empty() {
        notices.push("No available menu items were returned.".into());
    }
    Ok((items, notices))
}

/// Fetch fresh menus with at most `concurrency` locations in flight.
///
/// Names must be nonblank and IDs (parsed hostnames, otherwise names) unique.
/// Validate those invariants before any network access.  Unlinked entries are
/// retained without fetching; linked failures set [`Snapshot::complete`] to false.
///
/// # Errors
///
/// Returns an error for invalid identities, concurrency outside `1..=16`, or a
/// run crossing midnight in America/Los_Angeles.  Individual location failures
/// are recorded in the returned snapshot and reported to stderr.
pub async fn fetch_all(locations: Vec<Location>, concurrency: usize) -> Result<Snapshot> {
    ensure!(
        concurrency > 0 && concurrency <= 16,
        "Concurrency must be between 1 and 16"
    );
    let mut ids = HashSet::new();
    let locations = locations
        .into_iter()
        .map(|location| {
            ensure!(
                !location.name.trim().is_empty(),
                "Location name must not be empty"
            );
            let id = location
                .url
                .as_deref()
                .and_then(|url| Url::parse(url).ok())
                .and_then(|url| url.host_str().map(str::to_owned))
                .unwrap_or_else(|| location.name.clone());
            ensure!(
                ids.insert(id.clone()),
                "Duplicate location ID '{id}' for '{}'",
                location.name
            );
            Ok((id, location))
        })
        .collect::<Result<Vec<_>>>()?;
    let started_at = Utc::now();
    let day = started_at.with_timezone(&Pacific).date_naive();
    let mut results: Vec<_> = stream::iter(locations.into_iter().enumerate())
        .map(|(index, (id, location))| async move {
            let mut result = LocationResult {
                id,
                location,
                status: "no_ordering_url",
                fetched_at: None,
                error: None,
                notices: Vec::new(),
                items: Vec::new(),
            };
            if result.location.url.is_some() {
                let fetched = async {
                    let base = valid_base(&result.location)?;
                    let mut api = LiveApi::new(base)?;
                    let now = Utc::now();
                    ensure!(
                        now.with_timezone(&Pacific).date_naive() == day,
                        "Campus date changed during fetch; run again"
                    );
                    let data = gather(&mut api, &result.location, now).await?;
                    ensure!(
                        Utc::now().with_timezone(&Pacific).date_naive() == day,
                        "Campus date changed during fetch; run again"
                    );
                    Ok::<_, anyhow::Error>(data)
                }
                .await
                .with_context(|| format!("Fetching location {:?}", result.location.name));
                match fetched {
                    Ok((items, notices)) => {
                        result.status = "ok";
                        result.items = items;
                        result.notices = notices;
                        result.fetched_at = Some(Utc::now());
                    }
                    Err(error) => {
                        result.status = "error";
                        result.error = Some(format!("{error:#}"));
                    }
                }
            }
            eprintln!(
                "{}: {}, {} items",
                result.location.name,
                result.status,
                result.items.len()
            );
            if let Some(error) = &result.error {
                eprintln!("  {error}");
            }
            for notice in &result.notices {
                eprintln!("  {notice}");
            }
            (index, result)
        })
        .buffer_unordered(concurrency)
        .collect()
        .await;
    // Concurrent completion must not reorder the runtime catalog.
    results.sort_by_key(|(index, _)| *index);
    let locations: Vec<_> = results.into_iter().map(|(_, result)| result).collect();
    // Never publish mixed days if a run crosses campus midnight.
    ensure!(
        Utc::now().with_timezone(&Pacific).date_naive() == day,
        "Campus date changed during fetch; previous output retained; run again"
    );
    Ok(Snapshot {
        schema_version: 1,
        campus_day: day.to_string(),
        time_zone: "America/Los_Angeles",
        started_at,
        generated_at: Utc::now(),
        complete: locations.iter().all(|location| location.status != "error"),
        locations,
    })
}

/// Atomically replace `path` with a complete data script, creating parent directories.
///
/// A temporary file in the destination directory keeps replacement on the same
/// filesystem.  Both complete and partial snapshots are publishable; callers that
/// require all locations to succeed must check [`Snapshot::complete`] first.
///
/// # Errors
///
/// Directory, serialization, write, permission, and replacement failures propagate.
/// The destination is not replaced until the temporary script has been written
/// and synced.  This does not guarantee directory-entry durability after a crash.
pub fn write_script(path: &Path, snapshot: &Snapshot) -> Result<()> {
    write_atomic(path, |file| write_script_to(file, snapshot))
        .with_context(|| format!("Writing menu script to {}", path.display()))
}

/// Atomically write a publication badge, rounding the build time up to the next UTC minute.
///
/// # Errors
///
/// Timestamp, directory, write, permission, and replacement failures propagate.
pub fn write_badge(path: &Path, generated_at: DateTime<Utc>) -> Result<()> {
    (|| -> Result<()> {
        let timestamp = generated_at
            .checked_add_signed(chrono::TimeDelta::minutes(1))
            .and_then(|time| time.with_second(0))
            .and_then(|time| time.with_nanosecond(0))
            .context("Rounding publication badge timestamp")?
            .format("%Y-%m-%d %H:%M UTC")
            .to_string();
        write_atomic(path, |file| {
            writeln!(
                file,
                r##"<svg xmlns="http://www.w3.org/2000/svg" width="272" height="20" role="img" aria-label="Last published: {timestamp}">
  <title>Last published: {timestamp}</title>
  <rect width="272" height="20" rx="3" fill="#555"/>
  <path d="M104 0h165a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H104z" fill="#4c1"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="52" y="14">Last published</text>
    <text x="188" y="14">{timestamp}</text>
  </g>
</svg>"##
            )?;
            Ok(())
        })
    })()
    .with_context(|| format!("Writing publication badge to {}", path.display()))
}

fn write_atomic(path: &Path, write: impl FnOnce(&mut std::fs::File) -> Result<()>) -> Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    write(file.as_file_mut())?;
    file.flush()?;
    file.as_file().sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o644))?;
    }
    file.persist(path)
        .with_context(|| format!("Replacing {}", path.display()))?;
    Ok(())
}

/// Write and flush a readable `const menuData = ...;` script without diagnostics.
///
/// # Errors
///
/// Serialization, write, and flush failures propagate.  Unlike [`write_script`],
/// a writer failure can leave partial output, including with shell redirection.
pub fn write_script_to(writer: &mut impl Write, snapshot: &Snapshot) -> Result<()> {
    writer.write_all(b"// Generated by food-finder. Menu data only; no authentication credentials.\nconst menuData = ")?;
    serde_json::to_writer_pretty(&mut *writer, snapshot)?;
    writer.write_all(b";\n")?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now(value: &str) -> DateTime<Utc> {
        value.parse().unwrap()
    }

    fn store() -> Value {
        json!({
            "id": "site", "displayProfileId": "profile", "timeZone": "PST8PDT",
            "isScheduleOrderEnabled": true,
            "availableAt": {"opens": "11:10 am", "closes": "2:00 pm"},
            "displayOptions": {"currency/currencyCode": "USD", "onDemandTerminalId": "terminal"},
            "storePriceLevel": "level", "profitCenterId": "profit",
            "show86edItems": false, "useIgPosApi": false
        })
    }

    #[test]
    fn schedules_use_server_alignment_buffer_and_campus_date() {
        let scheduling = json!({"intervalTime": 20, "bufferTime": 30});
        assert_eq!(
            slot(&store(), &scheduling, now("2026-10-23T17:00:00Z")).unwrap(),
            Some(json!({"startTime":"12:10", "endTime":"12:30"}))
        );
        assert_eq!(
            slot(&store(), &scheduling, now("2026-10-23T19:01:00Z")).unwrap(),
            Some(json!({"startTime":"12:50", "endTime":"13:10"}))
        );
        assert_eq!(
            slot(&store(), &scheduling, now("2026-10-23T21:00:00Z")).unwrap(),
            None
        );
        assert_eq!(
            slot(&store(), &scheduling, now("2026-10-24T06:50:00Z")).unwrap(),
            None
        );
        assert!(
            slot(
                &store(),
                &json!({"intervalTime":0,"bufferTime":0}),
                Utc::now()
            )
            .is_err()
        );
        let mut overnight = store();
        overnight["availableAt"] = json!({"opens":"10:00 pm", "closes":"2:00 am"});
        assert!(slot(&overnight, &scheduling, Utc::now()).is_err());
    }

    #[test]
    fn schedules_accept_midnight_closing_without_losing_daytime_slots() {
        let scheduling = json!({"intervalTime": 15, "bufferTime": 20});
        let mut store = store();
        store["availableAt"] = json!({
            "openWindowTimeFrames": [
                {"opens": "11:00 am", "closes": "2:00 pm"},
                {"opens": "11:58 pm", "closes": "12:00 AM"}
            ]
        });
        assert_eq!(
            slot(&store, &scheduling, now("2026-10-28T12:00:00Z")).unwrap(),
            Some(json!({"startTime":"12:00", "endTime":"12:15"}))
        );
        assert_eq!(
            slot(&store, &scheduling, now("2026-10-28T22:00:00Z")).unwrap(),
            None
        );
        store["availableAt"] = json!({"opens": "11:45 pm", "closes": "00:00"});
        assert_eq!(
            slot(&store, &scheduling, now("2026-10-29T06:25:00Z")).unwrap(),
            Some(json!({"startTime":"23:45", "endTime":"00:00"}))
        );
        store["availableAt"]["closes"] = json!("2:00 am");
        assert!(slot(&store, &scheduling, now("2026-10-28T12:00:00Z")).is_err());
    }

    #[test]
    fn dated_vendor_hours_reject_overnight_windows() {
        let mut concept = json!({"availableAt":{"open":"11:00 am","close":"2:00 pm"}});
        let window = opening_window(&concept, &store(), now("2026-10-23T17:00:00Z"))
            .unwrap()
            .unwrap();
        assert_eq!(window.start, now("2026-10-23T18:00:00Z"));
        assert_eq!(window.end, now("2026-10-23T21:00:00Z"));
        concept["availableAt"]["close"] = json!("10:00 am");
        assert!(opening_window(&concept, &store(), Utc::now()).is_err());
    }

    struct FixtureApi {
        responses: std::collections::VecDeque<(&'static str, Value)>,
        posts: Vec<Value>,
    }

    impl MenuApi for FixtureApi {
        async fn request(&mut self, route: &str, body: Option<Value>) -> Result<Value> {
            let (expected, response) = self.responses.pop_front().context("Unexpected request")?;
            ensure!(route == expected, "Expected {expected}, got {route}");
            if let Some(body) = body {
                self.posts.push(body);
            }
            Ok(response)
        }
    }

    fn fixture(error_code: u16) -> FixtureApi {
        FixtureApi {
            responses: [
                ("login/anonymous", json!({"csrfToken":"not-persisted"})),
                ("config", json!({"tenantId":"tenant","properties":{"scheduledOrdering":{"intervalTime":20,"bufferTime":0}}})),
                ("sites/tenant", json!([store()])),
                ("sites/tenant/site/concepts/profile", json!([
                    {"id":"vendor","name":" Vendor ","menus":[],"schedule":[],
                     "availableAt":{"open":"11:00 am","close":"2:00 pm"}}
                ])),
                ("sites/tenant/site/concepts/profile/menus/vendor", json!([
                    {"isBoom":true,"output":{"statusCode":error_code,"payload":{"message":"Unavailable"}}},
                    {"id":"menu","name":"Today","categories":[
                        {"name":"Inline","items":[
                            {"id":"inline","displayText":"Fish","price":{"amount":"5.99","currencyUnit":"USD"}},
                            {"id":"hidden","isAvailableToGuests":false}
                        ]},
                        {"name":"Parent","subCategories":[
                            {"name":"Entrees","items":["lookup"]},
                            {"name":"Combos","packages":["package"]}
                        ]},
                        {"name":"Hidden","isAvailableToGuests":false,"items":["skip"]}
                    ]}
                ])),
                ("sites/tenant/site/kiosk-items/get-items", json!([
                    {"id":"lookup","name":"Soup","longDescription":"Hot","price":{"amount":3,"currencyUnit":"USD"}}
                ])),
                ("sites/tenant/site/kiosk-items/get-items", json!([
                    {"id":"package","name":"Combo","price":{"amount":"10.00","currencyUnit":"USD"}}
                ])),
            ].into(),
            posts: Vec::new(),
        }
    }

    #[tokio::test]
    async fn collects_inline_ids_packages_and_nested_categories_without_hidden_items() {
        let mut api = fixture(410);
        let location = Location {
            name: "Cafe".into(),
            url: Some("https://cafe16.buy-ondemand.com/".into()),
        };
        let (items, notices) = gather(&mut api, &location, now("2026-10-23T17:00:00Z"))
            .await
            .unwrap();
        assert!(api.responses.is_empty());
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].name, "Fish");
        assert_eq!(items[0].price, "5.99");
        assert_eq!(items[1].category, "Parent / Entrees");
        assert_eq!(items[1].description, "Hot");
        assert_eq!(
            items[0].ordering_url,
            "https://cafe16.buy-ondemand.com/?displayProfileId=profile"
        );
        assert!(items[0].vendor_opening_window.is_some());
        assert_eq!(api.posts[0]["scheduledDay"], 0);
        assert_eq!(api.posts[1]["currencyUnit"], "USD");
        assert_eq!(api.posts[2]["isCategoryHasItems"], true);
        assert_eq!(api.posts[3]["packageIds"], json!(["package"]));
        assert_eq!(notices, ["Vendor: Unavailable"]);
        assert!(
            !serde_json::to_string(&items)
                .unwrap()
                .contains("not-persisted")
        );
    }

    #[tokio::test]
    async fn embedded_errors_other_than_410_fail_the_location() {
        let mut api = fixture(500);
        let location = Location {
            name: "Cafe".into(),
            url: Some("https://cafe16.buy-ondemand.com/".into()),
        };
        assert!(
            gather(&mut api, &location, now("2026-10-23T17:00:00Z"))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn malformed_responses_report_entity_context_and_preserve_the_cause() {
        let location = Location {
            name: "Cafe".into(),
            url: Some("https://cafe16.buy-ondemand.com/".into()),
        };
        for (response_index, pointer, value, context, cause) in [
            (
                1,
                "/tenantId",
                Value::Null,
                "reading configuration tenant ID",
                "Missing tenantId",
            ),
            (
                2,
                "/0/displayProfileId",
                Value::Null,
                "store #1 (ID \"site\")",
                "Missing displayProfileId",
            ),
            (
                3,
                "/0/menus",
                Value::Null,
                "vendor \"Vendor\" (ID \"vendor\")",
                "Missing menus",
            ),
            (
                4,
                "/1/categories",
                json!({}),
                "menu #2 (ID \"menu\", name \"Today\")",
                "Expected an array",
            ),
            (
                4,
                "/1/categories/1/subCategories/0/items",
                json!(false),
                "category \"Parent / Entrees\"",
                "Expected an array",
            ),
            (
                4,
                "/1/categories/0/items/0/price/amount",
                json!("invalid"),
                "item #1 (ID \"inline\")",
                "Invalid item price",
            ),
        ] {
            let mut api = fixture(410);
            *api.responses[response_index]
                .1
                .pointer_mut(pointer)
                .unwrap() = value;
            let error = gather(&mut api, &location, now("2026-10-23T17:00:00Z"))
                .await
                .unwrap_err();
            let message = format!("{error:#}");
            for expected in ["Location \"Cafe\"", context, cause] {
                assert!(
                    message.contains(expected),
                    "{expected:?} missing from {message}"
                );
            }
            assert!(!message.contains("not-persisted"), "{message}");
        }
    }

    #[tokio::test]
    async fn item_lookup_failures_include_category_and_transport_cause() {
        let mut api = fixture(410);
        api.responses[5].0 = "simulated failed lookup";
        let location = Location {
            name: "Cafe".into(),
            url: Some("https://cafe16.buy-ondemand.com/".into()),
        };
        let error = gather(&mut api, &location, now("2026-10-23T17:00:00Z"))
            .await
            .unwrap_err();
        let message = format!("{error:#}");
        for expected in [
            "Location \"Cafe\"",
            "vendor \"Vendor\"",
            "menu #2",
            "category \"Parent / Entrees\": fetching items",
            "Expected simulated failed lookup, got sites/tenant/site/kiosk-items/get-items",
        ] {
            assert!(
                message.contains(expected),
                "{expected:?} missing from {message}"
            );
        }
    }

    #[tokio::test]
    async fn request_setup_failures_identify_method_and_url_without_credentials() {
        let mut api =
            LiveApi::new(Url::parse("https://cafe16.buy-ondemand.com/").unwrap()).unwrap();
        api.token = Some("test-bearer-not-to-log".into());
        let error = api
            .request("sites/tenant", Some(json!({})))
            .await
            .unwrap_err();
        let message = format!("{error:#}");
        assert!(
            message.contains("POST https://cafe16.buy-ondemand.com/api/sites/tenant"),
            "{message}"
        );
        assert!(message.contains("Missing CSRF credential"), "{message}");
        assert!(!message.contains("test-bearer-not-to-log"), "{message}");
    }

    #[tokio::test]
    async fn ordering_paths_use_returned_ids_and_stop_at_supported_depth() {
        let mut api = fixture(410);
        let menus = api.responses[4].1.as_array_mut().unwrap();
        menus.remove(0);
        let categories = menus[0]["categories"].as_array_mut().unwrap();
        categories[0]["id"] = json!("4");
        categories[1]["id"] = json!("7");
        categories[1]["subCategories"][0]["id"] = json!(0);
        categories[1]["subCategories"][1]["id"] = json!("3");
        let deeper = json!({
            "id": "deeper", "name": "Deeper", "items": [{
                "id":"deep-item", "name":"Deep dish", "price":{"amount":"1","currencyUnit":"USD"}
            }]
        });
        categories[1]["subCategories"][0]["subCategories"] = json!([deeper]);
        categories.insert(
            0,
            json!({"id":"0", "name":"Hidden", "isAvailableToGuests":false}),
        );
        categories.insert(1, json!({"id":"1", "name":"Empty", "items":[]}));
        let mut second_menu = menus[0].clone();
        second_menu["id"] = json!("other-menu");
        second_menu["categories"] = json!([{
            "id":"2", "name":"Other", "items":[{
                "id":"other-item", "name":"Other dish", "price":{"amount":"1","currencyUnit":"USD"}
            }]
        }]);
        menus.push(second_menu);
        let location = Location {
            name: "Cafe".into(),
            url: Some("https://cafe16.buy-ondemand.com/".into()),
        };
        let (items, _) = gather(&mut api, &location, now("2026-10-23T17:00:00Z"))
            .await
            .unwrap();
        let paths: Vec<_> = items
            .iter()
            .map(|item| item.ordering_category_path.clone())
            .collect();
        assert_eq!(
            paths,
            vec![
                Some(vec!["4".into()]),
                Some(vec!["7".into(), "0".into()]),
                Some(vec!["7".into(), "0".into()]),
                Some(vec!["7".into(), "3".into()]),
                None,
            ]
        );
    }

    #[tokio::test]
    async fn missing_parent_ids_do_not_turn_child_ids_into_top_level_routes() {
        let mut api = fixture(410);
        let menus = api.responses[4].1.as_array_mut().unwrap();
        menus.remove(0);
        menus[0]["categories"][1]["subCategories"][0]["id"] = json!("child");
        let location = Location {
            name: "Cafe".into(),
            url: Some("https://cafe16.buy-ondemand.com/".into()),
        };
        let (items, _) = gather(&mut api, &location, now("2026-10-23T17:00:00Z"))
            .await
            .unwrap();
        assert!(
            items
                .iter()
                .all(|item| item.ordering_category_path.is_none())
        );
    }

    #[tokio::test]
    async fn majority_failures_exclude_unlinked_and_count_empty_successes() {
        for (successful, failed, unlinked, expected) in [
            (0, 0, 1, false),
            (1, 0, 0, false),
            (0, 1, 0, true),
            (0, 1, 3, true),
            (2, 1, 0, false),
            (1, 1, 2, false),
            (1, 2, 3, true),
        ] {
            let locations = (0..successful + failed + unlinked)
                .map(|index| Location {
                    name: format!("Location {index}"),
                    url: (index < successful + failed)
                        .then(|| format!("https://site{index}.invalid/")),
                })
                .collect();
            let mut snapshot = fetch_all(locations, 2).await.unwrap();
            for location in snapshot.locations.iter_mut().take(successful) {
                location.status = "ok";
                location.error = None;
            }
            assert!(
                snapshot
                    .locations
                    .iter()
                    .all(|location| location.items.is_empty())
            );
            assert_eq!(
                snapshot.has_majority_failures(),
                expected,
                "{successful} successful, {failed} failed, {unlinked} unlinked"
            );
        }
    }

    #[tokio::test]
    async fn partial_output_is_atomic_executable_data_without_credentials() {
        let locations = vec![
            Location {
                name: "Unlinked".into(),
                url: None,
            },
            Location {
                name: "Invalid".into(),
                url: Some("https://example.invalid/".into()),
            },
        ];
        let snapshot = fetch_all(locations, 2).await.unwrap();
        assert!(!snapshot.complete);
        assert_eq!(snapshot.locations[0].status, "no_ordering_url");
        assert_eq!(snapshot.locations[1].status, "error");
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("menus.js");
        std::fs::write(&path, "previous complete file").unwrap();
        write_script(&path, &snapshot).unwrap();
        let script = std::fs::read_to_string(&path).unwrap();
        let json = script
            .split_once("const menuData = ")
            .unwrap()
            .1
            .strip_suffix(";\n")
            .unwrap();
        let data: Value = serde_json::from_str(json).unwrap();
        assert_eq!(data["schemaVersion"], 1);
        assert_eq!(data["locations"][1]["items"], json!([]));
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn publication_badge_rounds_up_in_utc_and_replaces_existing_output() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested/last-published.svg");
        for (generated_at, expected) in [
            ("2026-10-29T16:30:43.764Z", "2026-10-29 16:31 UTC"),
            ("2026-10-29T16:30:00Z", "2026-10-29 16:31 UTC"),
            ("2026-12-31T23:59:59.999Z", "2027-01-01 00:00 UTC"),
        ] {
            write_badge(&path, now(generated_at)).unwrap();
            let svg = std::fs::read_to_string(&path).unwrap();
            assert!(svg.contains(&format!("aria-label=\"Last published: {expected}\"")));
            assert!(svg.contains(&format!("<text x=\"188\" y=\"14\">{expected}</text>")));
            assert!(svg.ends_with("</svg>\n"));
            assert_eq!(
                std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
                1
            );
        }
        let previous = std::fs::read_to_string(&path).unwrap();
        assert!(write_badge(&path, DateTime::<Utc>::MAX_UTC).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), previous);
    }

    #[test]
    fn failed_atomic_write_preserves_previous_file_and_cleans_up_temporary_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("last-published.svg");
        std::fs::write(&path, "previous badge").unwrap();
        let error = write_atomic(&path, |file| {
            file.write_all(b"partial badge")?;
            bail!("simulated write failure")
        })
        .unwrap_err();
        assert!(error.to_string().contains("simulated write failure"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "previous badge");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    // Opt-in replay uses existing local captures; daily menus are never committed as fixtures.
    #[tokio::test]
    async fn replay_captured_catalog() {
        let Ok(path) = std::env::var("FOOD_FINDER_REPLAY") else {
            return;
        };
        let entries: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        struct ReplayApi {
            calls: Vec<Value>,
        }
        impl MenuApi for ReplayApi {
            async fn request(&mut self, route: &str, body: Option<Value>) -> Result<Value> {
                if route == "login/anonymous" {
                    return Ok(json!({}));
                }
                self.calls
                    .iter()
                    .find(|call| {
                        call["route"] == route
                            && call.get("body").filter(|v| !v.is_null()) == body.as_ref()
                    })
                    .map(|call| call["response"].clone())
                    .with_context(|| format!("No captured request for {route}"))
            }
        }
        for entry in list(&entries).unwrap() {
            let location: Location = serde_json::from_value(entry["location"].clone()).unwrap();
            let mut api = ReplayApi {
                calls: list(&entry["calls"]).unwrap().clone(),
            };
            let (items, _) = gather(&mut api, &location, now("2026-10-23T17:00:00Z"))
                .await
                .with_context(|| location.name.clone())
                .unwrap();
            let mut actual: Vec<_> = items
                .iter()
                .map(|item| {
                    (
                        item.location.clone(),
                        item.vendor.clone(),
                        item.category.clone(),
                        item.name.clone(),
                        Decimal::from_str(&item.price)
                            .unwrap()
                            .normalize()
                            .to_string(),
                        item.currency.clone(),
                    )
                })
                .collect();
            let mut expected: Vec<_> = list(&entry["expected"])
                .unwrap()
                .iter()
                .map(|item| {
                    (
                        text(item, "location").unwrap(),
                        text(item, "vendor").unwrap(),
                        text(item, "category").unwrap(),
                        text(item, "item").unwrap(),
                        Decimal::from_str(&text(&item["price"], "amount").unwrap())
                            .unwrap()
                            .normalize()
                            .to_string(),
                        text(&item["price"], "currencyUnit").unwrap(),
                    )
                })
                .collect();
            actual.sort();
            expected.sort();
            assert_eq!(actual, expected, "{}", location.name);
        }
    }
}
