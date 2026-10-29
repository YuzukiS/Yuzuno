//! Form replies are ordinary, explicitly submitted conversation messages.
//! Published result identity and answers are checked before a send receipt is
//! created. The Agent gate and existing receipts own delivery and deduplication.
use crate::{model::{Agent, ClarificationAnswer}, workspace::Workspace};
use anyhow::{ensure, Context, Result};
use rusqlite::OptionalExtension;
use serde_json::Value;
use std::sync::Arc;

impl Workspace {
    pub(crate) async fn validate_clarification(
        self: &Arc<Self>, agent: &Agent, answer: &ClarificationAnswer, text: &str,
    ) -> Result<()> {
        ensure!(!answer.result_id.is_empty() && answer.result_id.len() <= 100
            && !answer.form_id.is_empty() && answer.form_id.len() <= 64,
            "Invalid form reference");
        let (owner, result) = (agent.id.clone(), answer.result_id.clone());
        let (spec, session) = self.stored(move |store| {
            let db = store.db.read()?;
            let row: Option<(String, Option<String>, i64, i64)> = db.query_row(
                "SELECT r.spec_json,r.session_id,r.version,
                    (SELECT MAX(version) FROM interactive_results WHERE chain_id=r.chain_id)
                 FROM interactive_results r WHERE r.id=?1 AND r.agent_id=?2",
                [&result, &owner], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            ).optional()?;
            let (spec, session, version, latest) = row.context("The original form is unavailable. Your answers were not sent")?;
            ensure!(version == latest, "This form has been replaced. Open the latest version; your draft is kept");
            Ok((serde_json::from_str::<Value>(&spec)?, session))
        }).await?;
        // The same conversation the form was published in, for every harness.
        let current = crate::results::native_session(agent);
        ensure!(session == current && session.is_some(), "The original conversation has changed. Your answers were not sent");
        let checked = self.results.check_answers(&spec, &serde_json::to_value(answer)?).await?;
        ensure!(checked == text, "The submitted text does not match the original form and answers");
        Ok(())
    }
}
