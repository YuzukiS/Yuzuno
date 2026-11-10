//! Python 3.6 source compatibility of the Jobs helpers (YN-83).
//!
//! A remote machine runs these helpers with whatever `python3` it has, and the
//! Jobs contract starts at 3.6. This is a static check only: `ast.parse` with
//! `feature_version=(3, 6)` finds newer grammar, and the walk below finds APIs
//! that older interpreters lack. It does not run the helpers on Python 3.6.
//!
//! The checker requires an interpreter whose AST can really be asked for
//! `feature_version=(3, 6)`. Python 3.13 and later clamp that request to 3.7,
//! so they fail with `unsupported checker prerequisite` instead of passing on
//! a newer grammar. `YUZUNO_TEST_PYTHON` chooses the test interpreter (default
//! `python3`); that is a test-only choice and does not change the helper's
//! 3.6 contract.
//!
//! `remote_job.py` is itself a helper and also holds two sources as strings:
//! `COMMON`, executed by both helpers, and `SUPERVISOR`, executed by the
//! supervisor. All four segments are checked.

use std::path::Path;
use std::process::Command;

const CHECK: &str = r#"
import ast
import sys
from pathlib import Path

root = Path(sys.argv[1])
try:
    ast.parse("async = 1", feature_version=(3, 6))
except (SyntaxError, ValueError, TypeError) as error:
    print("unsupported checker prerequisite: Python %s cannot request feature_version=(3,6): %s"
          % (sys.version.split()[0], error))
    sys.exit(2)

job_path = root / "core/src/jobs/remote_job.py"
segments = [
    ("core/src/remote_helper.py", (root / "core/src/remote_helper.py").read_text(encoding="utf-8")),
    ("core/src/jobs/remote_job.py", job_path.read_text(encoding="utf-8")),
]
job = segments[1][1]
embedded = {}
for node in ast.parse(job, filename="core/src/jobs/remote_job.py").body:
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
        if node.targets[0].id in ("COMMON", "SUPERVISOR"):
            embedded[node.targets[0].id] = ast.literal_eval(node.value)

problems = []
for name in ("COMMON", "SUPERVISOR"):
    if name not in embedded:
        problems.append("core/src/jobs/remote_job.py: missing %s source" % name)
    else:
        segments.append(("core/src/jobs/remote_job.py:" + name, embedded[name]))

for label, source in segments:
    try:
        tree = ast.parse(source, filename=label, feature_version=(3, 6))
    except SyntaxError as error:
        problems.append("%s:%s: Python 3.6 syntax: %s" % (label, error.lineno, error.msg))
        continue
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            banned = sorted({word.arg for word in node.keywords if word.arg in ("capture_output", "text")})
            if banned:
                problems.append("%s:%s: keyword argument(s) %s" % (label, node.lineno,
                                                                    ", ".join(word + "=" for word in banned)))
        elif isinstance(node, ast.Attribute) and node.attr in ("removeprefix", "removesuffix"):
            problems.append("%s:%s: attribute .%s" % (label, node.lineno, node.attr))

for problem in problems:
    print(problem)
print("checked with Python %s, feature_version=(3,6)" % sys.version.split()[0])
print("%d Python 3.6 compatibility problem(s) in %d source segment(s)" % (len(problems), len(segments)))
sys.exit(1 if problems else 0)
"#;

/// Every helper source segment parses as Python 3.6 and avoids the newer
/// keyword arguments and string methods the design locks out.
#[test]
fn helper_sources_are_python_36_compatible() {
    // `CARGO_MANIFEST_DIR` is the `core` package; the checker takes the
    // repository root so that its paths name the same files here and in CI.
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("core has a parent");
    let python = std::env::var_os("YUZUNO_TEST_PYTHON").unwrap_or_else(|| "python3".into());
    let output = Command::new(python)
        .arg("-I")
        .arg("-c")
        .arg(CHECK)
        .arg(root)
        .output()
        .expect("the YUZUNO_TEST_PYTHON interpreter (default python3) is needed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "remote helpers are not Python 3.6 compatible:\n{stdout}{stderr}"
    );
    assert!(
        stdout.contains("checked with Python ") && stdout.contains("feature_version=(3,6)"),
        "the check did not use a real Python 3.6 grammar:\n{stdout}{stderr}"
    );
    assert!(
        stdout.contains("0 Python 3.6 compatibility problem(s) in 4 source segment(s)"),
        "the check did not cover all four helper sources:\n{stdout}{stderr}"
    );
}
