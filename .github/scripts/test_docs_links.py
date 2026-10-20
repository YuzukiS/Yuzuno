"""Fixtures for docs_links.py: small Git repositories with base and head
commits. Run: python3 -m unittest discover -s .github/scripts
"""
import os
import subprocess
import tempfile
import unittest
from unittest import mock

import docs_links
from test_pr_scope import GIT_ENV

GUIDE = """# Guide

## Install it
## Install it
<a id="custom"></a>
### `code` and **bold** [link](guide.md)
"""

INDEX = """# Index

See [guide](docs/guide.md), [install](docs/guide.md#install-it), [second](docs/guide.md#install-it-1),
[custom](docs/guide.md#custom), [heading with code](docs/guide.md#code-and-bold-link),
[here](#index), [folder](docs/), [rooted](/docs/guide.md), ![logo](docs/logo.png),
[web](https://example.invalid/missing), [mail](mailto:x@example.invalid), [code line](core/lib.rs#L10).

[ref]: docs/guide.md

```sh
[not a link](missing.md)
```
Inline `[also not](missing.md)` code.
"""


class Links(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.git("init", "-q", "-b", "main")
        self.write("README.md", INDEX)
        self.write("docs/guide.md", GUIDE)
        self.write("docs/logo.png", "png")
        self.write("core/lib.rs", "fn f() {}\n")
        self.write("evidence.md", "[local evidence](acceptance/report.json)\n")
        self.base = self.commit()

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", "-C", self.root, *args], env=GIT_ENV, check=True, capture_output=True).stdout.decode()

    def write(self, path, text):
        full = os.path.join(self.root, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as f:
            f.write(text)

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", "c")
        return self.git("rev-parse", "HEAD").strip()

    def broken(self, rev=None):
        return docs_links.broken(docs_links.Tree(self.root, rev or "HEAD"))[1]

    def new(self, head):
        return docs_links.introduced(docs_links.broken(docs_links.Tree(self.root, head))[1],
                                     docs_links.broken(docs_links.Tree(self.root, self.base))[1])

    def new_with_renames(self, head):
        return docs_links.introduced(docs_links.broken(docs_links.Tree(self.root, head))[1],
                                     docs_links.broken(docs_links.Tree(self.root, self.base))[1],
                                     docs_links.renames(self.root, self.base, head))

    def test_valid_links_anchors_and_skipped_kinds(self):
        # Only the untracked evidence link is broken; code blocks, external URLs and #L anchors are skipped.
        self.assertEqual([(p[0], p[2]) for p in self.broken()], [("evidence.md", "acceptance/report.json")])

    def test_broken_file_and_anchor_are_reported_with_lines(self):
        self.write("docs/new.md", "# New\n\n[gone](missing.md)\n[bad](guide.md#nope)\n[up](../../outside.md)\n")
        head = self.commit()
        problems = {(p[0], p[1], p[2]) for p in self.new(head)}
        self.assertEqual(problems, {("docs/new.md", 3, "missing.md"), ("docs/new.md", 4, "guide.md#nope"),
                                    ("docs/new.md", 5, "../../outside.md")})

    def test_existing_breakage_is_not_counted(self):
        self.write("README.md", INDEX + "\nMore text.\n")
        head = self.commit()
        self.assertEqual(len(self.broken(head)), 1)
        self.assertEqual(self.new(head), [])

    def test_deleting_or_renaming_a_linked_doc_is_caught(self):
        self.git("mv", "docs/guide.md", "docs/moved.md")
        head = self.commit()
        targets = {p[2] for p in self.new(head)}
        self.assertIn("docs/guide.md", targets)
        self.assertIn("docs/guide.md#install-it", targets)

    def test_changed_heading_breaks_its_anchor(self):
        self.write("docs/guide.md", GUIDE.replace("## Install it\n## Install it\n", "## Setup\n## Install it\n"))
        head = self.commit()
        self.assertEqual({p[2] for p in self.new(head)}, {"docs/guide.md#install-it-1"})

    def test_a_second_copy_of_an_existing_broken_link_counts(self):
        self.write("evidence.md", "[local evidence](acceptance/report.json)\n[again](acceptance/report.json)\n")
        head = self.commit()
        self.assertEqual([(p[0], p[1]) for p in self.new(head)], [("evidence.md", 2)])

    def test_renamed_source_keeps_its_existing_breakage(self):
        self.git("mv", "evidence.md", "notes.md")
        self.assertEqual(self.new_with_renames(self.commit()), [])

    def test_moved_source_is_matched_but_a_link_it_breaks_by_moving_counts(self):
        self.write("record.md", "[local evidence](acceptance/report.json)\n[guide](docs/guide.md)\n")
        self.base = self.commit()
        self.git("mv", "record.md", "docs/record.md")
        head = self.commit()
        # The evidence link was already broken; the guide link breaks because of the move.
        self.assertEqual([(p[0], p[2]) for p in self.new_with_renames(head)], [("docs/record.md", "docs/guide.md")])

    def test_footnotes_are_not_links(self):
        self.write("docs/notes.md", "Text.[^1]\n\n[^1]: See the guide.\n[^long-note]: Another one.\n")
        head = self.commit()
        self.assertEqual(self.new(head), [])

    def test_main_exit_codes_and_summary(self):
        with tempfile.TemporaryDirectory() as out, mock.patch.dict(os.environ):
            os.environ.pop("GITHUB_STEP_SUMMARY", None)
            self.assertEqual(docs_links.main(["docs_links.py", "--base", self.base, self.root]), 0)
            self.assertEqual(docs_links.main(["docs_links.py", self.root]), 1)
            self.write("docs/new.md", "[gone](missing.md)\n")
            self.commit()
            summary = os.path.join(out, "summary")
            os.environ["GITHUB_STEP_SUMMARY"] = summary
            self.assertEqual(docs_links.main(["docs_links.py", "--base", self.base, self.root]), 1)
            self.assertEqual(docs_links.main(["docs_links.py", "--base"]), 2)
            with open(summary) as f:
                self.assertIn("1 newly broken; 1 were already broken at the base", f.read())

    def test_slug_rules(self):
        self.assertEqual(docs_links.slug("Run from source"), "run-from-source")
        self.assertEqual(docs_links.slug("PR CI on WSL"), "pr-ci-on-wsl")
        self.assertEqual(docs_links.slug("`job_budget` and **disk**"), "job_budget-and-disk")
        self.assertEqual(docs_links.slug("What's new? (v2)"), "whats-new-v2")
        self.assertEqual(docs_links.slug("中文 标题"), "中文-标题")


if __name__ == "__main__":
    unittest.main()
