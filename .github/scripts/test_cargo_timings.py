"""cargo_timings.py against reports shaped as Cargo 1.97 writes them: the
summary table and the UNIT_DATA, CONCURRENCY_DATA and CPU_USAGE constants.
Run: python3 -m unittest discover -s .github/scripts
"""
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
import unittest.mock

import cargo_timings


def unit(i, name, target, start, duration, sections=None, mode="todo", version="0.1.0"):
    return {"i": i, "name": name, "version": version, "mode": mode, "target": target, "features": [],
            "start": start, "duration": duration, "unblocked_units": [], "unblocked_rmeta_units": [], "sections": sections}


def lib_sections(frontend, codegen):
    return [["frontend", {"start": 0.0, "end": frontend}], ["codegen", {"start": frontend, "end": frontend + codegen}]]


UNITS = [
    unit(0, "serde", "", 0.0, 0.0),                                   # fresh: the cache restored it
    unit(1, "ring", " build-script", 0.0, 0.0),
    unit(2, "ring", " build-script (run)", 0.0, 0.0, mode="run-custom-build"),
    unit(3, "zstd-sys", "", 0.0, 12.0, lib_sections(2.0, 10.0)),       # built: a dependency the cache missed
    unit(4, "core-app", "", 12.0, 100.0, lib_sections(60.0, 40.0)),
    unit(5, "core-app", ' core_app "lib" (test)', 72.0, 300.0),
    unit(6, "core-app", ' signals "test" (test)', 112.0, 50.0),
    unit(7, "core-app", ' jobs "test" (test)', 112.0, 70.0),
    unit(8, "core-app", ' core-app "bin"', 112.0, 30.0),
    unit(9, "core-app", ' core-app "bin" (test)', 142.0, 5.0),
    unit(10, "core-app", ' lab "example"', 147.0, 20.0),
    unit(11, "core-app", " build-script", 0.0, 1.0),
    unit(12, "core-app", ' odd target', 0.0, 0.5),
]
CONCURRENCY = [
    {"t": 0.0, "active": 2, "waiting": 0, "inactive": 9},
    {"t": 12.0, "active": 1, "waiting": 0, "inactive": 8},
    {"t": 72.0, "active": 2, "waiting": 0, "inactive": 6},
    {"t": 112.0, "active": 3, "waiting": 2, "inactive": 1},
    {"t": 200.0, "active": 1, "waiting": 0, "inactive": 0},
]
CPU = [[10.0, 50.0], [100.0, 100.0], [300.0, 30.0]]


def report(units=UNITS, concurrency=CONCURRENCY, cpu=CPU, fresh=3, dirty=10):
    return f"""<html><body>
<table class="my-table summary-table">
<tr>
<td>Targets:</td><td>core-app 0.1.0 (lib)<br>core-app 0.1.0 ( jobs "test")</td>
</tr>
<tr>
<td>Fresh units:</td><td>{fresh}</td>
</tr>
<tr>
<td>Dirty units:</td><td>{dirty}</td>
</tr>
<tr>
<td>Max concurrency:</td><td>3 (jobs=3 ncpu=3)</td>
</tr>
<tr>
<td>rustc:</td><td>rustc 1.97.1 (8bab26f4f 2026-07-14)<br>Host: aarch64-apple-darwin<br>Target: aarch64-apple-darwin</td>
</tr>
</table>
<script>
const UNIT_DATA = {json.dumps(units, indent=2)};
const CONCURRENCY_DATA = {json.dumps(concurrency, indent=2)};
const CPU_USAGE = {json.dumps(cpu, indent=2)};
const BOX_HEIGHT = 25;
</script></body></html>
"""


FIXTURE = Path(__file__).with_name("fixtures") / "cargo-timing-1.97.1.html"


class Kinds(unittest.TestCase):
    def test_a_real_cargo_1_97_report(self):
        # Copied from cargo 1.97.1's own report, the toolchain CI pins: the
        # labels are what Cargo writes, not what this test assumes.
        units, concurrency, cpu, fields = cargo_timings.parse(FIXTURE.read_text())
        kinds = sorted((u["name"], u["target"], cargo_timings.kind_of(u)) for u in units)
        self.assertEqual(kinds, [
            ("core-app", "", "lib"),
            ("core-app", " build-script", "build script"),
            ("core-app", " build-script (run)", "build script run"),
            ("core-app", ' core-app "bin"', "bin"),
            ("core-app", ' core-app "bin" (test)', "bin test"),
            ("core-app", ' core-helper "bin"', "bin"),
            ("core-app", ' core-helper "bin" (test)', "bin test"),
            ("core-app", ' core_app "lib" (test)', "lib test"),
            ("core-app", ' lab "example"', "example"),
            ("core-app", ' signals "test" (test)', "integration test"),
            ("core-app", ' speed "bench" (test)', "bench"),
            ("derive-probe", "", "lib"),
            ("helper", "", "lib"),
        ])
        result = cargo_timings.summarize(units, concurrency, cpu, fields)
        packages = {(g["package"], g["kind"]) for g in result["groups"]}
        self.assertIn(("core-app", "integration test"), packages)
        self.assertIn((None, "lib"), packages)  # helper and derive-probe: dependencies
        self.assertNotIn(("helper", "lib"), packages)
        self.assertEqual([lib["unit"] for lib in result["workspaceLibraries"]], ["core-app 0.1.0"])
        self.assertEqual(set(result["workspaceLibraries"][0]["sections"]), {"frontend", "codegen"})
        self.assertFalse(result["linkSplit"])
        self.assertEqual(fields["Fresh units"], "0")
        self.assertTrue(fields["rustc"].startswith("rustc 1.97.1 "))

    def test_older_cargos_kind_first_labels(self):
        cases = {' bin "core-app"': "bin", ' bin "core-app" (test)': "bin test", ' test "jobs" (test)': "integration test",
                 ' example "lab"': "example", ' bench "speed" (test)': "bench", " lib (test)": "lib test",
                 " build script": "build script", " build script (run)": "build script run"}
        for target, kind in cases.items():
            with self.subTest(target=target):
                self.assertEqual(cargo_timings.kind_of({"target": target}), kind)

    def test_each_target_form(self):
        cases = {"": "lib", " build-script": "build script", " build-script (run)": "build script run",
                 ' x "lib" (test)': "lib test", ' x "bin"': "bin", ' x "bin" (test)': "bin test",
                 ' it "test" (test)': "integration test", ' ex "example"': "example", ' b "bench" (test)': "bench",
                 ' m "proc-macro"': "lib", " something else": "other", ' x "staticlib"': "other"}
        for target, kind in cases.items():
            with self.subTest(target=target):
                self.assertEqual(cargo_timings.kind_of({"target": target}), kind)
        self.assertEqual(cargo_timings.kind_of({"target": "", "mode": "run-custom-build"}), "build script run")


class Summary(unittest.TestCase):
    def setUp(self):
        self.result = cargo_timings.summarize(*cargo_timings.parse(report()))
        self.groups = {(g["package"], g["kind"]): g for g in self.result["groups"]}

    def test_workspace_and_dependency_units_are_told_apart(self):
        # core-app has test, binary and example units, so it is the workspace's.
        self.assertEqual(self.groups[(None, "lib")]["units"], 2)
        self.assertEqual(self.groups[(None, "lib")]["built"], 1)
        self.assertEqual(self.groups[(None, "lib")]["longest"], {"unit": "zstd-sys 0.1.0", "seconds": 12.0})
        self.assertEqual(self.groups[(None, "build script run")]["units"], 1)
        self.assertEqual(self.groups[("core-app", "lib")]["sections"], {"frontend": 60.0, "codegen": 40.0})
        self.assertEqual(self.groups[("core-app", "lib test")]["seconds"], 300.0)
        self.assertEqual(self.groups[("core-app", "integration test")]["units"], 2)
        self.assertEqual(self.groups[("core-app", "integration test")]["seconds"], 120.0)
        self.assertEqual(self.groups[("core-app", "integration test")]["longest"]["unit"], 'core-app 0.1.0 jobs "test" (test)')
        self.assertEqual(self.groups[("core-app", "other")]["units"], 1)
        # The workspace's rows come first, in the kinds' order.
        self.assertEqual([g["kind"] for g in self.result["groups"] if g["package"]][:3], ["lib", "lib test", "integration test"])

    def test_wall_time_concurrency_and_cpu(self):
        self.assertEqual(self.result["wall"], 372.0)  # the lib's tests end last: 72 + 300
        self.assertEqual(self.result["concurrency"], {
            "1": {"seconds": 232.0, "waiting": 0.0},   # 12..72 and 200..372
            "2": {"seconds": 52.0, "waiting": 0.0},    # 0..12 and 72..112
            "3": {"seconds": 88.0, "waiting": 88.0},   # 112..200
        })
        self.assertEqual(self.result["cpuMean"], 60.0)
        self.assertEqual(self.result["workspaceLibraries"],
                         [{"unit": "core-app 0.1.0", "start": 12.0, "seconds": 100.0, "end": 112.0,
                           "sections": {"frontend": 60.0, "codegen": 40.0}}])
        self.assertEqual([u["seconds"] for u in self.result["slowest"][:3]], [300.0, 100.0, 70.0])
        self.assertNotIn(0.0, [u["seconds"] for u in self.result["slowest"]])

    def test_the_summary_says_what_it_cannot_tell(self):
        text = cargo_timings.markdown(self.result)
        self.assertIn("**372.0 s** from the first unit's start", text)
        self.assertIn("10 built, 3 fresh", text)
        self.assertIn("| core-app: library | 1 | 1 | 100.0 s | frontend 60.0 s, codegen 40.0 s |", text)
        self.assertIn("| core-app: integration tests | 2 | 2 | 120.0 s |", text)
        self.assertIn("the build went on for 260.0 s after it", text)
        self.assertIn("| 3 | 88.0 s | 24% | 88.0 s |", text)
        self.assertIn("cannot tell the two apart", text)
        self.assertIn("rustc 1.97.1 \\(8bab26f4f 2026-07-14\\)", text)
        self.assertNotIn("Host", text)
        self.assertNotIn("Targets", json.dumps(self.result))

    def test_a_link_section_would_be_shown(self):
        units = UNITS[:6] + [unit(6, "core-app", ' signals "test" (test)', 112.0, 50.0,
                                  [["frontend", {"start": 0, "end": 10}], ["codegen", {"start": 10, "end": 30}], ["link", {"start": 30, "end": 50}]])]
        result = cargo_timings.summarize(*cargo_timings.parse(report(units)))
        self.assertTrue(result["linkSplit"])
        self.assertIn("link 20.0 s", cargo_timings.markdown(result))
        self.assertNotIn("cannot tell the two apart", cargo_timings.markdown(result))

    def test_names_are_plain_text(self):
        units = [unit(0, "a|b`<i>", ' t\n"test" (test)', 0.0, 1.0), unit(1, "a|b`<i>", ' x "test" (test)', 0.0, 2.0)]
        text = cargo_timings.markdown(cargo_timings.summarize(*cargo_timings.parse(report(units))))
        self.assertIn("a\\|b\\`\\<i\\>", text)
        self.assertNotIn("<i>", text)
        self.assertNotIn("a|b", text)


class Main(unittest.TestCase):
    def run_main(self, content):
        with tempfile.TemporaryDirectory() as tmp:
            path, summary = os.path.join(tmp, "cargo-timing.html"), os.path.join(tmp, "summary")
            if content is not None:
                with open(path, "w") as f:
                    f.write(content)
            with unittest.mock.patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": summary}), \
                    unittest.mock.patch("sys.stdout", new_callable=io.StringIO) as out:
                code = cargo_timings.main(["cargo_timings.py", path])
            with open(summary) as f:
                return code, out.getvalue(), f.read()

    def test_a_report_gives_a_summary_and_one_json_line(self):
        code, out, summary = self.run_main(report())
        self.assertEqual(code, 0)
        [line] = [l for l in out.splitlines() if l.startswith("cargo-timings-json: ")]
        self.assertEqual(json.loads(line.split(": ", 1)[1])["wall"], 372.0)
        self.assertIn("### Cargo build timings", summary)

    def test_anything_unreadable_is_said_and_never_fails(self):
        cases = {"no report": None,
                 "no unit data": "<html>Cargo Build Timings</html>",
                 "not JSON": "const UNIT_DATA = [{nope}];\n",
                 "units without times": "const UNIT_DATA = [{\"name\": \"a\"}];\n",
                 "a time that is not a number": 'const UNIT_DATA = [{"name": "a", "target": "", "start": "soon", "duration": 1}];\n'}
        for label, content in cases.items():
            with self.subTest(label):
                code, out, summary = self.run_main(content)
                self.assertEqual(code, 0)
                self.assertIn("::warning title=Cargo timings::no summary: ", out)
                self.assertEqual(len(out.splitlines()), 1)
                self.assertIn("No summary: ", summary)

    def test_usage(self):
        self.assertEqual(cargo_timings.main(["cargo_timings.py"]), 2)


if __name__ == "__main__":
    unittest.main()
