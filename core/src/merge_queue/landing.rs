//! How a repository's checked entries land on its base branch. Each
//! repository names its landing; this Core has one, `core-merge`, the
//! default: Core sends the merge itself (`remote::merge`). Two more are
//! named for a later Core, behind `land`, without changing the queue around
//! it: `github-auto-merge` (GitHub merges once the required checks pass) and
//! `github-merge-queue` (GitHub's own merge queue, where the repository has
//! it). This Core names them and refuses them.
use super::remote::{self, MergeOutcome};
use crate::workspace::Workspace;
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::sync::Arc;

pub(super) const DEFAULT: &str = "core-merge";
/// The landings a later Core adds.
pub(super) const PLANNED: [&str; 2] = ["github-auto-merge", "github-merge-queue"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Landing {
    CoreMerge,
}

impl Landing {
    /// The landing a stored value names, or None for one this Core does not
    /// have (written by a later Core).
    pub(super) fn named(value: &Value) -> Option<Self> {
        match value.as_str().unwrap_or(DEFAULT) {
            "core-merge" => Some(Self::CoreMerge),
            _ => None,
        }
    }

    /// The landing the user chooses for a repository, or why this Core
    /// refuses it.
    pub(super) fn chosen(name: &str) -> Result<Self> {
        match Self::named(&json!(name)) {
            Some(landing) => Ok(landing),
            None if PLANNED.contains(&name) => {
                bail!("invalid_input: this Core has no {name} landing; it lands with core-merge only")
            }
            None => bail!("invalid_input: unknown landing {name:?}; this Core lands with core-merge"),
        }
    }

    pub(super) fn name(self) -> &'static str {
        match self {
            Self::CoreMerge => DEFAULT,
        }
    }
}

/// Land a merging entry the way its merge recorded when it started.
pub(super) async fn land(ws: &Arc<Workspace>, entry: &Value) -> Result<MergeOutcome> {
    match Landing::named(&entry["merge"]["landing"]) {
        Some(Landing::CoreMerge) => remote::merge(ws, entry).await,
        None => Ok(MergeOutcome::Held(format!(
            "This Core cannot land with '{}'; nothing was sent.",
            entry["merge"]["landing"].as_str().unwrap_or("?")
        ))),
    }
}
