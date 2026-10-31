//! Compact review discovery, shared with the GUI index where their fields agree.
//! Historical detail remains versioned, extensible evidence, not a closed schema.
use serde_json::{json, Map, Value};

pub(super) const LIST_MORE: &str = "review_get(taskId, reviewId) reads findings and uncovered paths; view \"full\" adds the original report, context reads, ledger and per-file evidence";

const INDEX_FIELDS: &[(&str, &str)] = &[
    ("id", "string"),
    ("taskId", "string"),
    ("linkId", "string"),
    ("repository", "string"),
    ("number", "integer"),
    ("url", "string"),
    ("round", "integer"),
    ("kind", "string"),
    ("parentReviewId", "string"),
    ("previousReviewId", "string"),
    ("status", "string"),
    ("phase", "string"),
    ("conclusion", "string"),
    ("policyVersion", "integer"),
    ("coveragePolicyVersion", "integer"),
    ("reasonCodes", "array"),
    ("requestedHarness", "string"),
    ("requestedModel", "string"),
    ("actualHarness", "string"),
    ("actualModel", "string"),
    ("baseSha", "string"),
    ("headSha", "string"),
    ("mergeBaseSha", "string"),
    ("createdAt", "string"),
    ("finishedAt", "string"),
    ("error", "string"),
    ("requestedBy", "object"),
];
const COVERAGE_COUNTS: &[&str] = &[
    "fileCount",
    "coveredFileCount",
    "deliveredCompleteDiffs",
    "uninspectedCount",
    "failedRequestCount",
    "unresolvedRequests",
];
const SCOPE_COUNTS: &[&str] = &[
    "covered",
    "excluded",
    "unsupported",
    "budget_exhausted",
    "read_failed",
    "not_read",
];

/// Keep the pre-existing GUI index's nulls and fields unchanged.
pub(super) fn index_row(data: &Value) -> Map<String, Value> {
    INDEX_FIELDS
        .iter()
        .map(|(key, _)| ((*key).into(), data[*key].clone()))
        .collect()
}

fn count(value: &Value) -> Value {
    json!(value.as_array().map(Vec::len))
}

pub(super) fn list_row(data: &Value) -> Value {
    let mut row = Value::Object(index_row(data));
    row["reviewId"] = data
        .get("reviewId")
        .filter(|id| !id.is_null())
        .unwrap_or(&data["id"])
        .clone();
    for key in [
        "cursor",
        "outdated",
        "requestedBaseSha",
        "requestedHeadSha",
        "contextIncomplete",
        "acknowledgedUnreviewable",
    ] {
        row[key] = data[key].clone();
    }
    row["reviewerStarted"] = json!(data.get("actualHarness").map(|h| !h.is_null()));
    row["findingsCount"] = count(&data["findings"]);
    row["settledFindingsCount"] = count(&data["settledFindings"]);
    // Missing historical coverage is unknown. In particular, do not mistake
    // deliveredCompleteDiffs for unique covered files under newer policies.
    let coverage = &data["coverage"];
    row["coverage"] = if coverage.is_object() {
        let mut counts = Map::new();
        for key in COVERAGE_COUNTS {
            counts.insert((*key).into(), coverage[*key].clone());
        }
        counts.insert("uninspectedCount".into(), count(&coverage["uninspected"]));
        counts.insert(
            "failedRequestCount".into(),
            count(&coverage["failedRequests"]),
        );
        counts.insert("terminalLimit".into(), coverage["terminalLimit"].clone());
        Value::Object(counts)
    } else {
        Value::Null
    };
    let scope = &data["scope"];
    row["scopeCounts"] = if scope["counts"].is_object() {
        Value::Object(
            SCOPE_COUNTS
                .iter()
                .map(|key| ((*key).into(), scope["counts"][*key].clone()))
                .collect(),
        )
    } else {
        Value::Null
    };
    row["scopeCheckAfterReview"] = scope["checkAfterReview"].clone();
    row
}

fn nullable(kind: &str) -> Value {
    json!({"type":[kind,"null"]})
}

fn closed(properties: Map<String, Value>) -> Value {
    let required: Vec<_> = properties.keys().cloned().collect();
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

pub(super) fn list_schema() -> Value {
    let mut row: Map<String, Value> = INDEX_FIELDS
        .iter()
        .map(|(key, kind)| ((*key).into(), nullable(kind)))
        .collect();
    row.insert(
        "reasonCodes".into(),
        json!({"type":["array","null"],"items":{"type":"string"}}),
    );
    for key in [
        "reviewId",
        "requestedBaseSha",
        "requestedHeadSha",
        "scopeCheckAfterReview",
    ] {
        row.insert(key.into(), nullable("string"));
    }
    row.insert("cursor".into(), json!({"type":"integer"}));
    for key in [
        "outdated",
        "contextIncomplete",
        "acknowledgedUnreviewable",
        "reviewerStarted",
    ] {
        row.insert(key.into(), nullable("boolean"));
    }
    for key in ["findingsCount", "settledFindingsCount"] {
        row.insert(key.into(), nullable("integer"));
    }
    let mut coverage: Map<String, Value> = COVERAGE_COUNTS
        .iter()
        .map(|key| ((*key).into(), nullable("integer")))
        .collect();
    coverage.insert("terminalLimit".into(), nullable("string"));
    row.insert(
        "coverage".into(),
        json!({"anyOf":[closed(coverage),{"type":"null"}]}),
    );
    let scope = SCOPE_COUNTS
        .iter()
        .map(|key| ((*key).into(), nullable("integer")))
        .collect();
    row.insert(
        "scopeCounts".into(),
        json!({"anyOf":[closed(scope),{"type":"null"}]}),
    );
    let settings = closed(
        [
            ("harness".into(), json!({"type":"string"})),
            ("model".into(), json!({"type":"string"})),
            (
                "source".into(),
                json!({"type":"string","enum":["project","workspace","builtin"]}),
            ),
        ]
        .into_iter()
        .collect(),
    );
    let success = closed(
        [
            ("settings".into(), settings),
            (
                "reviews".into(),
                json!({"type":"array","maxItems":20,"items":closed(row)}),
            ),
            ("hasMore".into(), json!({"type":"boolean"})),
            ("nextBefore".into(), nullable("integer")),
            ("more".into(), json!({"type":"string"})),
        ]
        .into_iter()
        .collect(),
    );
    // Validation and Store failures are structured tool errors, not successful
    // pages. A row with status failed and its own error still belongs to success.
    let error = closed(
        [("error".into(), json!({"type":"string"}))]
            .into_iter()
            .collect(),
    );
    json!({"type":"object","oneOf":[success,error]})
}

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod tests;
