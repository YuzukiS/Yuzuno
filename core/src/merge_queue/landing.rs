//! How a repository's checked entries land on its base branch. Each
//! repository names its landing; this Core has one, `core-merge`, the
//! default: Core sends the merge itself (`remote::merge`). A later Core can
//! add another (`github-auto-merge` is planned) behind `land` without
//! changing the queue around it.
use super::remote::{self, MergeOutcome};
use crate::workspace::Workspace;
use anyhow::Result;
use serde_json::Value;
use std::sync::Arc;

pub(super) const DEFAULT: &str = "core-merge";

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
