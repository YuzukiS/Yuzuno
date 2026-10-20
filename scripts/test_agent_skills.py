import os
import pathlib
import tempfile
import unittest

import check_agent_skills

ROOT = pathlib.Path(__file__).resolve().parent.parent


class AgentSkills(unittest.TestCase):
    def test_repository_skills_are_loadable_by_both_harnesses(self):
        names, problems = check_agent_skills.check(ROOT)
        self.assertIn("yuzuno", names)
        self.assertEqual(problems, [])

    def test_a_copy_broken_link_or_unaccepted_key_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            skill = root / ".agents/skills/demo"
            (skill / "references").mkdir(parents=True)
            (skill / "SKILL.md").write_text(
                "---\nname: demo\ndescription: Demo skill.\nversion: 1\n---\n\n"
                "[gone](references/gone.md) [here](references/here.md#missing)\n")
            (skill / "references/here.md").write_text("# Here\n")
            (root / ".claude/skills/demo").mkdir(parents=True)
            _, problems = check_agent_skills.check(root)
            text = "\n".join(problems)
            self.assertIn("not accepted by Codex", text)
            self.assertIn("broken link references/gone.md", text)
            self.assertIn("missing anchor references/here.md#missing", text)
            self.assertIn("must be a link", text)
            os.rmdir(root / ".claude/skills/demo")
            os.symlink("../../.agents/skills/demo", root / ".claude/skills/demo")
            (skill / "SKILL.md").write_text("---\nname: demo\ndescription: Demo skill.\n---\n\n[here](references/here.md#here)\n")
            self.assertEqual(check_agent_skills.check(root)[1], [])


if __name__ == "__main__":
    unittest.main()
