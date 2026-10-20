//! An acknowledgement inside the existing ordered native event queue. This
//! waits for the consumer, not just a snapshot cache flush or transport exit.
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

pub struct EventBarrier {
    sender: mpsc::Sender<Value>,
    pending: Mutex<HashMap<String, oneshot::Sender<()>>>,
    closing: AtomicBool,
}
struct PendingMarker<'a> {
    barrier: &'a EventBarrier,
    id: String,
}
impl Drop for PendingMarker<'_> {
    fn drop(&mut self) {
        self.barrier.pending.lock().unwrap().remove(&self.id);
    }
}
impl EventBarrier {
    pub fn new(sender: mpsc::Sender<Value>) -> Arc<Self> {
        Arc::new(Self {
            sender,
            pending: Mutex::new(HashMap::new()),
            closing: AtomicBool::new(false),
        })
    }
    pub fn mark_closing(&self) {
        self.closing.store(true, Ordering::Release);
    }
    pub fn is_closing(&self) -> bool {
        self.closing.load(Ordering::Acquire)
    }
    pub fn acknowledge(&self, event: &Value) -> bool {
        let Some(id) = event["_yuzunoUpdateBarrier"].as_str() else {
            return false;
        };
        if let Some(reply) = self.pending.lock().unwrap().remove(id) {
            let _ = reply.send(());
            return true;
        }
        false
    }
    pub async fn drain(&self) -> Result<()> {
        let id = uuid::Uuid::new_v4().to_string();
        let (send, receive) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), send);
        let _marker = PendingMarker {
            barrier: self,
            id: id.clone(),
        };
        let result = tokio::time::timeout(Duration::from_secs(15), async {
            self.sender
                .send(json!({"_yuzunoUpdateBarrier":id}))
                .await
                .context("Native event queue closed before its barrier")?;
            receive
                .await
                .context("Native event consumer stopped before its barrier")
        })
        .await
        .context("Native events did not finish persisting before update");
        result?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn barrier_does_not_finish_before_earlier_events_are_consumed() {
        let (send, mut receive) = mpsc::channel(8);
        let barrier = EventBarrier::new(send.clone());
        send.send(json!({"terminal":true})).await.unwrap();
        let task = tokio::spawn({
            let barrier = barrier.clone();
            async move { barrier.drain().await }
        });
        assert_eq!(receive.recv().await.unwrap()["terminal"], true);
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        assert!(!barrier.acknowledge(&json!({"_yuzunoUpdateBarrier":"unregistered"})));
        assert!(barrier.acknowledge(&receive.recv().await.unwrap()));
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn cancelled_barrier_removes_its_pending_receipt() {
        let (send, mut receive) = mpsc::channel(1);
        let barrier = EventBarrier::new(send);
        let task = tokio::spawn({
            let barrier = barrier.clone();
            async move { barrier.drain().await }
        });
        receive.recv().await.unwrap();
        assert_eq!(barrier.pending.lock().unwrap().len(), 1);
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(barrier.pending.lock().unwrap().is_empty());
    }
}
