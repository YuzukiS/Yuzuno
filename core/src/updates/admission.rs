//! One shared admission boundary for native starts, GUI mutations and mail wakeups.
//! A permit is held until the accepted request finishes; existing Turns complete
//! through the separate continuation lane, which closes only at final sealing.
use anyhow::{bail, ensure, Result};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionState {
    pub operation_id: Option<String>,
    pub in_flight: usize,
    pub sealed: bool,
}

#[derive(Default)]
pub struct Admission {
    state: Mutex<AdmissionState>,
    pub changed: Notify,
}

pub struct Permit(Arc<Admission>);

impl Permit {
    pub(crate) fn validate(&self, admission: &Arc<Admission>) -> Result<()> {
        ensure!(
            Arc::ptr_eq(&self.0, admission),
            "Admission permit belongs to another Workspace"
        );
        Ok(())
    }
}

impl Admission {
    pub fn snapshot(&self) -> AdmissionState {
        self.state.lock().unwrap().clone()
    }

    pub fn enter_work(self: &Arc<Self>) -> Result<Permit> {
        self.enter(false)
    }

    /// Approval responses, interrupts and completion bookkeeping can still run
    /// while draining. The final seal requires even these requests to finish.
    pub fn enter_completion(self: &Arc<Self>) -> Result<Permit> {
        self.enter(true)
    }

    /// Only update control for this draining operation may use this lane. The
    /// caller additionally verifies its journal phase/deadline and native Turn.
    pub(crate) fn enter_update_notice(self: &Arc<Self>, operation: &str) -> Result<Permit> {
        let mut state = self.state.lock().unwrap();
        ensure!(!state.sealed && state.operation_id.as_deref() == Some(operation),
            "Update notice no longer owns admission");
        state.in_flight += 1;
        Ok(Permit(Arc::clone(self)))
    }

    /// Native events accepted before transport shutdown must finish even after
    /// the HTTP/work lane seals. Their ordered queue barrier joins these writers.
    pub(crate) fn enter_event(self: &Arc<Self>) -> Permit {
        self.state.lock().unwrap().in_flight += 1;
        Permit(Arc::clone(self))
    }

    fn enter(self: &Arc<Self>, completion: bool) -> Result<Permit> {
        let mut state = self.state.lock().unwrap();
        if state.sealed || (!completion && state.operation_id.is_some()) {
            bail!("workspace_updating: Workspace is preparing an update. Your input was not sent; keep the draft or cancel the update wait.");
        }
        state.in_flight += 1;
        Ok(Permit(Arc::clone(self)))
    }

    /// Mutually exclusive with accepting a new permit; this is an admission
    /// fence, not a reading of an eventually-consistent Agent status.
    pub fn begin_drain(&self, operation_id: &str) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        ensure!(!state.sealed, "Update already entered its switching phase");
        ensure!(
            state
                .operation_id
                .as_deref()
                .is_none_or(|id| id == operation_id),
            "Another update is waiting"
        );
        state.operation_id = Some(operation_id.into());
        self.changed.notify_waiters();
        Ok(())
    }

    /// Coordinator first verifies no active Turns/Pending and flushes events.
    /// A concurrent completion permit makes sealing fail; it must flush again.
    pub fn try_seal(&self, operation_id: &str) -> Result<bool> {
        let mut state = self.state.lock().unwrap();
        ensure!(
            state.operation_id.as_deref() == Some(operation_id),
            "Update does not own admission"
        );
        if state.in_flight != 0 {
            return Ok(false);
        }
        state.sealed = true;
        Ok(true)
    }

    /// After producers stop, join the last asynchronous persistence writers.
    /// Register before checking the count so the final Drop cannot be missed.
    pub async fn wait_quiescent(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.snapshot().in_flight == 0 {
                return;
            }
            changed.await;
        }
    }

    pub fn reopen(&self, operation_id: &str) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        ensure!(
            state.operation_id.as_deref() == Some(operation_id),
            "Update does not own admission"
        );
        state.operation_id = None;
        state.sealed = false;
        self.changed.notify_waiters();
        Ok(())
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap();
        state.in_flight -= 1;
        self.0.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepted_request_blocks_seal_and_new_work_cannot_cross_drain() {
        let gate = Arc::new(Admission::default());
        let accepted = gate.enter_work().unwrap();
        gate.begin_drain("update").unwrap();
        assert!(gate.enter_work().is_err());
        assert!(!gate.try_seal("update").unwrap());
        let response = gate.enter_completion().unwrap();
        drop(accepted);
        assert!(!gate.try_seal("update").unwrap());
        drop(response);
        assert!(gate.try_seal("update").unwrap());
        assert!(gate.enter_completion().is_err());
        gate.reopen("update").unwrap();
        assert!(gate.enter_work().is_ok());
    }

    #[test]
    fn cancel_is_owned_and_does_not_lose_in_flight_permits() {
        let gate = Arc::new(Admission::default());
        let accepted = gate.enter_work().unwrap();
        gate.begin_drain("a").unwrap();
        assert!(gate.begin_drain("b").is_err());
        assert!(gate.reopen("b").is_err());
        gate.reopen("a").unwrap();
        assert_eq!(gate.snapshot().in_flight, 1);
        drop(accepted);
        assert_eq!(gate.snapshot().in_flight, 0);
    }

    #[tokio::test]
    async fn accepted_permit_survives_drain_and_final_seal_joins_late_event_writers() {
        let gate = Arc::new(Admission::default());
        let accepted = gate.enter_work().unwrap();
        gate.begin_drain("a").unwrap();
        accepted.validate(&gate).unwrap();
        assert_eq!(gate.snapshot().in_flight, 1);
        assert!(accepted.validate(&Arc::new(Admission::default())).is_err());
        drop(accepted);
        assert!(gate.try_seal("a").unwrap());
        let writer = gate.enter_event();
        let joined = tokio::spawn({
            let gate = gate.clone();
            async move { gate.wait_quiescent().await }
        });
        tokio::task::yield_now().await;
        assert!(!joined.is_finished());
        drop(writer);
        tokio::time::timeout(std::time::Duration::from_secs(1), joined)
            .await
            .unwrap()
            .unwrap();
        assert!(gate.try_seal("a").unwrap());
    }
}
