//! yuzuno_guide names the managed release it was set to (T-131). A process of
//! its own: the release is set once per process, as main.rs does at start.
use serde_json::json;
use yuzuno_workspace::guide;

#[test]
fn the_guide_names_the_managed_release_set_at_start_and_keeps_it() {
    let sha = "0123456789abcdef0123456789abcdef01234567";
    guide::set_release("core-20261018-0123456", "2026.10.18-core.10", sha);
    guide::set_release("another", "other", "f".repeat(40).as_str());
    for topic in [json!({}), json!({"topic":"maintenance"})] {
        let answer = guide::answer(&topic).unwrap();
        assert_eq!(
            answer["core"],
            json!({"releaseId":"core-20261018-0123456","version":"2026.10.18-core.10","gitSha":sha,"managed":true})
        );
        assert_eq!(answer["revision"], guide::revision());
    }
}
