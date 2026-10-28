//! Declarative command-line interface for the menu scraper.
//!
//! Clap handles syntax, required arguments, and concurrency bounds.  Catalog
//! contents and location selection are validated after loading the runtime file;
//! ordering URL failures remain per-location errors in the output snapshot.

use clap::Parser;
use std::path::PathBuf;

/// Fetch fresh campus menus into a standalone website's data script.
#[derive(Debug, Parser)]
#[command(about = "Fetch fresh campus menus. No request or menu cache is used.")]
pub(crate) struct Args {
    /// Generated data script; deploy beside web/index.html
    ///
    /// When omitted, write only the data script to stdout.  Named files are
    /// replaced atomically, including when a partial snapshot is produced.
    #[arg(long)]
    pub(crate) output: Option<PathBuf>,

    /// JSON location catalog to read at runtime (names and ordering URLs)
    #[arg(long, alias = "catalog")]
    pub(crate) urls: PathBuf,

    /// Exact catalog location name; repeat to select multiple locations (default: all)
    #[arg(long)]
    pub(crate) location: Vec<String>,

    /// Maximum simultaneous location fetches
    #[arg(long, default_value_t = 4, value_parser = clap::value_parser!(u8).range(1..=16))]
    pub(crate) concurrency: u8,
}
