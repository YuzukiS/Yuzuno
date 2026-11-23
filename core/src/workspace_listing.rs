//! The Agent list of `/api/workspace` for a page that asks for less
//! (`?listing=slim`, YN-221 S3). A released executor's row keeps only what
//! the Agent list, search, Home's cards and the task board read of it
//! (`SLIM_FIELDS`), with `listing: "slim"`; every other row, a working
//! executor's included, is the full row. The page reads one released
//! executor's full row with `GET /api/agents/{id}/listing` when it opens it.
//! Without the parameter the list is as it always was.
use serde_json::{json, Map, Value};

/// The marker a slim row and a slim list carry.
pub const SLIM: &str = "slim";

/// What a released executor's slim row keeps, besides its machine (`remote`
/// as `{machine: {id, name}}`) and its lifecycle (`executor`, without its
/// temporary directory and its route's credential).
pub const SLIM_FIELDS: [&str; 21] = [
    "id", "name", "kind", "harness", "status", "color", "createdAt", "updatedAt", "closedAt", "disconnectedAt",
    "projectId", "releasedAt", "releasedBy", "rev", "lastSeq", "reviewedSeq", "pendingCount", "openQuestions",
    "unreadCount", "workSummary", "cwd",
];

/// An executor released for good (executor_lifecycle.rs `archived`).
pub fn released(agent: &Value) -> bool {
    agent["kind"] == "executor" && agent["executor"]["state"] == "archived"
}

/// The row a slim list has for this Agent's full row.
pub fn slim(agent: Value) -> Value {
    if !released(&agent) {
        return agent;
    }
    let Value::Object(full) = agent else { return agent };
    let mut row = Map::new();
    for field in SLIM_FIELDS {
        if let Some(value) = full.get(field) {
            row.insert(field.to_owned(), value.clone());
        }
    }
    if let Some(machine) = full.get("remote").and_then(|remote| remote.get("machine")) {
        row.insert("remote".into(), json!({"machine":{"id":machine["id"],"name":machine["name"]}}));
    }
    if let Some(mut executor) = full.get("executor").cloned() {
        if let Some(fields) = executor.as_object_mut() {
            fields.remove("tempDir");
            if let Some(route) = fields.get_mut("route").and_then(Value::as_object_mut) {
                route.remove("credential");
            }
        }
        row.insert("executor".into(), executor);
    }
    row.insert("listing".into(), json!(SLIM));
    Value::Object(row)
}

#[cfg(test)]
#[path = "workspace_listing_tests.rs"]
mod tests;
