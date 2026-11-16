//! YN-173, before the fix: the entry point Core's collaboration worker will
//! call for a route's owed images and files, doing nothing yet.
use crate::workspace::Workspace;
use anyhow::Result;
use std::sync::Arc;

impl Workspace {
    pub(crate) async fn deliver_owed_attachments(self: &Arc<Self>) -> Result<()> {
        Ok(())
    }
}
