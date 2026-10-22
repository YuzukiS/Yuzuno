//! Managed local Core + Web UI releases. Native session state remains in Workspace.
pub mod admission;
pub mod api;
pub mod assets;
pub mod catalog;
#[cfg(unix)]
pub mod control;
pub mod controller;
pub mod desktop_releases;
pub mod events;
#[cfg(unix)]
pub mod helper;
pub mod lifecycle;
pub(crate) mod notices;
pub mod package;
pub mod releases;
#[cfg(unix)]
pub mod start;
pub mod state;
pub mod storage;
#[cfg(test)]
mod tests;
