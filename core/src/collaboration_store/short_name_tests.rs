//! T-43: a task's short name, what the sidebar names its executor by.
use super::{tool_definitions, SHORT_NAME_CHARS};
use crate::store::Store;
use serde_json::{json, Value};

fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    (dir, store)
}

#[test]
fn a_short_name_is_one_trimmed_line_of_at_most_16_characters_and_null_or_empty_clears_it() {
    let (_dir, s) = store();
    let created = s
        .collaboration_call(None, "task_create", json!({"requestId":"c","title":"Export and import device preferences","shortName":"  导出设备偏好  "}))
        .unwrap();
    let id = created["task"]["id"].as_str().unwrap().to_owned();
    assert_eq!(created["task"]["shortName"], "导出设备偏好", "kept trimmed");
    assert_eq!(created["activity"]["changes"]["shortName"], "导出设备偏好", "and recorded");
    // Characters, not bytes: sixteen CJK characters fit, seventeen don't.
    let sixteen: String = "导出导入设备偏好设置和外观语言通知".chars().take(SHORT_NAME_CHARS).collect();
    assert_eq!(sixteen.chars().count(), 16);
    let fits = s.collaboration_call(None, "task_create", json!({"requestId":"fits","title":"t","shortName":sixteen})).unwrap();
    assert_eq!(fits["task"]["shortName"], json!(sixteen));
    for (n, (bad, why)) in [
        (json!("导出导入设备偏好设置和外观语言通知"), "at most 16 characters"),
        (json!("two\nlines"), "one line"),
        (json!(7), "must be a string or null"),
    ]
    .into_iter()
    .enumerate()
    {
        let error = s
            .collaboration_call(None, "task_create", json!({"requestId":format!("bad-{n}"),"title":"t","shortName":bad}))
            .unwrap_err()
            .to_string();
        assert!(error.contains(why), "{error}");
    }
    // None given: none kept, and the task's JSON has no such key.
    let plain = s.collaboration_call(None, "task_create", json!({"requestId":"plain","title":"No name"})).unwrap();
    assert!(plain["task"].get("shortName").is_none(), "{}", plain["task"]);
    assert!(plain["activity"]["changes"].get("shortName").is_none());

    let update = |version: i64, value: Value| {
        s.collaboration_call(None, "task_update", json!({"requestId":format!("u{version}"),"taskId":id,"expectedVersion":version,"patch":{"shortName":value}}))
            .unwrap()
    };
    let renamed = update(1, json!(" 设备偏好 "));
    assert_eq!(renamed["task"]["shortName"], "设备偏好");
    assert_eq!(renamed["activity"]["changes"]["shortName"], "设备偏好", "the change as kept");
    // Where it is read: the task's current view and its compact row.
    let current = s.collaboration_call(None, "task_get", json!({"taskId":id})).unwrap();
    assert_eq!(current["current"]["shortName"], "设备偏好", "{current}");
    let rows = s.collaboration_call(None, "task_list", json!({"compact":true})).unwrap();
    let row = rows["tasks"].as_array().unwrap().iter().find(|t| t["id"] == json!(id)).unwrap().clone();
    assert_eq!(row["shortName"], "设备偏好", "{row}");
    // Cleared by null, and by an empty one.
    let cleared = update(2, Value::Null);
    assert!(cleared["task"].get("shortName").is_none(), "{}", cleared["task"]);
    assert_eq!(cleared["activity"]["changes"]["shortName"], Value::Null);
    assert_eq!(s.collaboration_call(None, "task_get", json!({"taskId":id})).unwrap()["current"]["shortName"], Value::Null);
    update(3, json!("x"));
    assert!(update(4, json!("   "))["task"].get("shortName").is_none(), "an empty one is none");
}

#[test]
fn task_create_and_task_update_take_a_short_name() {
    let tools = tool_definitions();
    let tool = |name: &str| tools.iter().find(|t| t["name"] == name).unwrap().clone();
    let create = &tool("task_create")["inputSchema"]["properties"]["shortName"];
    let update = &tool("task_update")["inputSchema"]["properties"]["patch"]["properties"]["shortName"];
    assert_eq!(create, update, "the same field in both");
    assert_eq!(create["maxLength"], 16);
    assert_eq!(create["type"], json!(["string", "null"]));
    assert!(create["description"].as_str().unwrap().contains("plain words"));
}
