//! Python 3.6 source compatibility of the Jobs helpers (YN-83).
//!
//! A remote machine runs these helpers with whatever `python3` it has, and the
//! Jobs contract starts at 3.6. This is a static check only: `ast.parse` with
//! `feature_version=(3, 6)` finds newer grammar, and the walk below finds APIs
//! that older interpreters lack. It does not run the helpers on Python 3.6.
//!
//! Python 3.13 and later cannot be asked for `feature_version=(3, 6)`: their
//! AST minimum is `(3, 7)`. The checker probes for that with `async = 1`
//! (an identifier in 3.6, reserved from 3.7) and prints which version it used,
//! rather than silently treating a 3.7 parse as a 3.6 one. On such an
//! interpreter the 3.7 parse is still a stricter syntax check for this source
//! (it rejects the same `async`/`await` identifiers), but it is not evidence
//! of a real Python 3.6 run.
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

def requests_36():
    try:
        ast.parse("async = 1", feature_version=(3, 6))
        return True
    except SyntaxError:
        return False

if requests_36():
    version = (3, 6)
    mode = "feature_version=3.6"
else:
    version = (3, 7)
    mode = "feature_version=3.7 (3.6 is below this interpreter's AST minimum)"
print("checking with %s" % mode)

for label, source in segments:
    try:
        tree = ast.parse(source, filename=label, feature_version=version)
    except SyntaxError as error:
        problems.append("%s:%s: syntax beyond Python 3.6 (%s): %s" % (label, error.lineno, mode, error.msg))
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
print("%d Python 3.6 compatibility problem(s) in %d source segment(s)" % (len(problems), len(segments)))
sys.exit(1 if problems else 0)
"#;

/// Every helper source segment parses as Python 3.6, or as the closest feature
/// version the host AST supports, and avoids the newer keyword arguments and
/// string methods the design locks out.
#[test]
fn helper_sources_are_python_36_compatible() {
    // `CARGO_MANIFEST_DIR` is the `core` package; the checker takes the
    // repository root so that its paths name the same files here and in CI.
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("core has a parent");
    let output = Command::new("python3")
        .arg("-I")
        .arg("-c")
        .arg(CHECK)
        .arg(root)
        .output()
        .expect("python3 is needed for the Python 3.6 compatibility check");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "remote helpers are not Python 3.6 compatible:\n{stdout}{stderr}"
    );
    assert!(
        stdout.contains("0 Python 3.6 compatibility problem(s) in 4 source segment(s)"),
        "the check did not cover all four helper sources:\n{stdout}{stderr}"
    );
}
