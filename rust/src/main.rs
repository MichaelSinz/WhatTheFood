//! Command-line pipeline: load and select locations, fetch menus, then publish.
//!
//! Stdout is reserved for the generated script; diagnostics go to stderr.
//! A partial snapshot is still published but produces a failing exit status.
//! Invalid input and fatal fetch/write errors also fail, without claiming success.

mod cli;

use anyhow::{Context, Result};
use clap::Parser;
use cli::Args;
use food_finder::{Location, fetch_all, write_script, write_script_to};
use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    match run(Args::parse()).await {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("Error: {error:#}");
            ExitCode::FAILURE
        }
    }
}

/// Publish one snapshot, returning whether every linked location succeeded.
///
/// `Ok(false)` means partial data was written, not that publication failed.
/// `Err` covers invalid input and fatal fetch or output errors.
async fn run(args: Args) -> Result<bool> {
    let catalog = std::fs::read_to_string(&args.urls)
        .with_context(|| format!("Reading {}", args.urls.display()))?;
    let mut locations: Vec<Location> = serde_json::from_str(&catalog)
        .with_context(|| format!("Invalid location catalog: {}", args.urls.display()))?;
    // Validate every requested name before filtering so typos cannot silently
    // publish a different set of locations.
    for name in &args.location {
        anyhow::ensure!(
            locations.iter().any(|location| &location.name == name),
            "Unknown location: {name}"
        );
    }
    if !args.location.is_empty() {
        locations.retain(|location| args.location.contains(&location.name));
    }
    anyhow::ensure!(!locations.is_empty(), "The catalog is empty");
    let snapshot = fetch_all(locations, args.concurrency as usize).await?;
    if let Some(path) = &args.output {
        write_script(path, &snapshot)?;
    } else {
        write_script_to(&mut std::io::stdout().lock(), &snapshot)
            .context("Writing menu script to stdout")?;
    }
    eprintln!(
        "Wrote {} items to {}{}",
        snapshot
            .locations
            .iter()
            .map(|l| l.items.len())
            .sum::<usize>(),
        args.output
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or("stdout".into()),
        if snapshot.complete {
            ""
        } else {
            " (PARTIAL: some locations failed)"
        }
    );
    Ok(snapshot.complete)
}
