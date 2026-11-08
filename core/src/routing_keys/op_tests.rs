//! Reading a routing key through 1Password (YN-34 S1a), against a stub `op`
//! that records its arguments and environment. Synthetic values only; no
//! real op, account or token.
use super::*;
use std::{fs, os::unix::fs::PermissionsExt, path::Path};

/// YUZUNO_OP_BIN and the variables these tests set are the process's.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const TOKEN: &str = "ops_test-yn34-token-0123456789";
const VALUE: &str = "sk-test-yn34-op-value-0123456789";
const REFERENCE: &str = "op://Vault/OpenAI API/credential";

/// A stub op in `dir`: `--version` prints `dir/version` (2.30.0 without
/// one); `read` answers as `dir/mode` says. Every run writes its arguments
/// and environment beside it.
fn stub(dir: &Path) {
    let d = dir.display();
    let script = format!(r#"#!/bin/sh
D='{d}'
env | sort > "$D/env.last"
printf '%s\n' "$@" > "$D/args.last"
if [ "$1" = --version ]; then
  if [ -f "$D/version" ]; then cat "$D/version"; else echo 2.30.0; fi
  exit 0
fi
case "$(cat "$D/mode")" in
  ok) case "$3" in *'?attribute=type') printf CONCEALED ;; *) printf '{VALUE}' ;; esac; exit 0 ;;
  missing) echo "[ERROR] 2026/11/08 10:00:00 could not read secret '$3': \"OpenAI\" isn't an item in the \"Vault\" vault" >&2; exit 1 ;;
  down) echo '[ERROR] 2026/11/08 10:00:00 dial tcp: lookup my.1password.com: no such host' >&2; exit 1 ;;
  rejected) echo '[ERROR] 2026/11/08 10:00:00 (401) Unauthorized: You aren'"'"'t authorized: invalid token' >&2; exit 1 ;;
  limited) echo "[ERROR] (429) Too Many Requests: You've reached the maximum number of this type of requests" >&2; exit 1 ;;
  leaky) echo 'unexpected: sk-test-yn34-leak-in-stderr' >&2; exit 3 ;;
  slow) sleep 30 ;;
esac
"#);
    let path = dir.join("op");
    fs::write(&path, script).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    std::env::set_var("YUZUNO_OP_BIN", &path);
}

fn mode(dir: &Path, mode: &str) {
    fs::write(dir.join("mode"), mode).unwrap();
}

fn store_with_token(dir: &Path) -> Store {
    let store = Store::of(&dir.join("data"));
    store.put_token(Secret::new(TOKEN.into())).unwrap();
    store
}

#[tokio::test]
async fn op_gets_only_path_home_and_the_token() {
    let _serial = SERIAL.lock().await;
    let tmp = tempfile::tempdir().unwrap();
    stub(tmp.path());
    mode(tmp.path(), "ok");
    std::env::set_var("OP_CONNECT_HOST", "https://connect.example.invalid");
    std::env::set_var("YN34_TEST_OTHER_SECRET", "sk-test-yn34-not-for-op");
    let store = store_with_token(tmp.path());
    let value = read(&store, REFERENCE).await.unwrap();
    std::env::remove_var("OP_CONNECT_HOST");
    std::env::remove_var("YN34_TEST_OTHER_SECRET");
    assert_eq!(value.expose(), VALUE);
    let env = fs::read_to_string(tmp.path().join("env.last")).unwrap();
    let names: Vec<&str> = env.lines().filter_map(|l| l.split('=').next()).filter(|n| !["PWD", "SHLVL", "_", "OLDPWD"].contains(n)).collect();
    assert_eq!(names, ["HOME", "OP_SERVICE_ACCOUNT_TOKEN", "PATH"], "{env}");
    assert!(env.contains(&format!("OP_SERVICE_ACCOUNT_TOKEN={TOKEN}")));
    let args = fs::read_to_string(tmp.path().join("args.last")).unwrap();
    assert_eq!(args.lines().collect::<Vec<_>>(), ["read", "--no-newline", REFERENCE]);
}

#[tokio::test]
async fn a_check_asks_for_the_fields_type_never_its_value() {
    let _serial = SERIAL.lock().await;
    let tmp = tempfile::tempdir().unwrap();
    stub(tmp.path());
    mode(tmp.path(), "ok");
    let store = store_with_token(tmp.path());
    check(&store, REFERENCE).await.unwrap();
    let args = fs::read_to_string(tmp.path().join("args.last")).unwrap();
    assert_eq!(args.lines().collect::<Vec<_>>(), ["read", "--no-newline", &format!("{REFERENCE}?attribute=type")]);
}

#[tokio::test]
async fn each_way_a_key_cannot_be_had_says_why_in_both_languages() {
    let _serial = SERIAL.lock().await;
    let tmp = tempfile::tempdir().unwrap();
    stub(tmp.path());
    // No token: op is never run.
    let empty = Store::of(&tmp.path().join("empty"));
    let why = read(&empty, REFERENCE).await.unwrap_err();
    assert_eq!((why.code, why.message.as_str(), why.message_zh.as_str()),
        ("tokenMissing", "The 1Password service account's token is not set", "1Password 服务账号的令牌没设置"));
    assert!(!tmp.path().join("args.last").exists(), "op was not run");
    let store = store_with_token(tmp.path());
    for (stub_mode, code, zh) in [
        ("missing", "referenceNotFound", format!("1Password 里找不到 {REFERENCE}")),
        ("down", "unreachable", "1Password 连不上，取不到 key".to_string()),
        ("slow", "unreachable", "1Password 连不上，取不到 key".to_string()),
        ("rejected", "tokenRejected", "1Password 不接受服务账号的令牌".to_string()),
        ("limited", "rateLimited", "服务账号的 1Password 请求次数到上限了，稍后再试".to_string()),
    ] {
        mode(tmp.path(), stub_mode);
        for answer in [read(&store, REFERENCE).await.map(|_| ()), check(&store, REFERENCE).await] {
            let why = answer.unwrap_err();
            assert_eq!((why.code, &why.message_zh), (code, &zh), "{stub_mode}");
        }
    }
}

#[tokio::test]
async fn what_op_printed_never_reaches_the_reason() {
    let _serial = SERIAL.lock().await;
    let tmp = tempfile::tempdir().unwrap();
    stub(tmp.path());
    mode(tmp.path(), "leaky");
    let store = store_with_token(tmp.path());
    let why = read(&store, REFERENCE).await.unwrap_err();
    let shown = serde_json::to_string(&why).unwrap();
    assert_eq!(why.code, "failed");
    assert!(shown.contains("exit 3") && !shown.contains("sk-test-yn34-leak"), "{shown}");
}

#[tokio::test]
async fn an_op_without_service_accounts_or_none_at_all_is_said() {
    let _serial = SERIAL.lock().await;
    let tmp = tempfile::tempdir().unwrap();
    stub(tmp.path());
    mode(tmp.path(), "ok");
    fs::write(tmp.path().join("version"), "2.17.9\n").unwrap();
    let store = store_with_token(tmp.path());
    let why = read(&store, REFERENCE).await.unwrap_err();
    assert_eq!((why.code, why.message.as_str()), ("opTooOld", "op 2.17.9 is too old: service accounts need 2.18.0 or later"));
    let args = fs::read_to_string(tmp.path().join("args.last")).unwrap();
    assert_eq!(args.trim(), "--version", "read was not run");
    assert_eq!(installed().await["supported"], false);
    fs::write(tmp.path().join("version"), "2.32.1\n").unwrap();
    assert_eq!(installed().await, serde_json::json!({"found": true, "version": "2.32.1", "supported": true}));
    std::env::set_var("YUZUNO_OP_BIN", tmp.path().join("no-such-op"));
    let why = read(&store, REFERENCE).await.unwrap_err();
    assert_eq!(why.code, "opMissing");
    assert_eq!(installed().await["found"], false);
}

#[test]
fn references_are_checked() {
    for good in ["op://Vault/Item/field", "op://My Vault/OpenAI API/section one/credential"] {
        assert_eq!(check_reference(&format!("  {good} ")).unwrap(), good);
    }
    for bad in ["", "Vault/Item/field", "op://Vault/Item", "op://Vault//field", "op://V/I/f?attribute=value", "op://V/I/f\n", "op://a/b/c/d/e"] {
        assert!(check_reference(bad).is_err(), "{bad:?}");
    }
    assert_eq!(version_in("2.30.0\n"), Some((2, 30, 0)));
    assert_eq!(version_in("op version 2.18.0-beta.01"), Some((2, 18, 0)));
    assert_eq!(version_in("unknown"), None);
}
