# Working on Yuzuno

The active development repository is [YuzukiS/Yuzuno](https://github.com/YuzukiS/Yuzuno). Start new work from its `main`, and open pull requests against this repository.

The private development repository is historical material. Move a remaining change as a reviewed patch onto public `main`; do not merge its old Git history into this repository. Keep the existing task, findings and review-attempt limits when a change moves repositories.

Read [Contributing](CONTRIBUTING.md) for setup and checks. Agents connected to a Yuzuno Workspace should also read the [Yuzuno skill](.agents/skills/yuzuno/SKILL.md), or the connected Core's `yuzuno_guide`. The skill is shared by both harnesses; do not copy it into a second location.

Use focused checks for the change and reuse relevant evidence for unchanged code. Public CI runs only on GitHub-hosted runners; local background work in a connected Workspace uses managed Jobs.

Use synthetic examples for machine names, user paths and research data. Keep local acceptance outputs and credentials out of commits. Source publication does not authorize uploading private release packages or SDK bundles; releases follow [the release guide](docs/core-release.md).
