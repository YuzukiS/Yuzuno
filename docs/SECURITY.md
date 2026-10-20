# Security

Yuzuno is alpha software.

## Reporting a vulnerability

Report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability** ([https://github.com/YuzukiS/Yuzuno/security/advisories/new](https://github.com/YuzukiS/Yuzuno/security/advisories/new)). The report stays private between you and the maintainers. There is no security contact address.

Keep vulnerability details out of public places:

- Do not describe a vulnerability or how to exploit it in an issue, a pull request, a discussion or a CI log.
- Do not include tokens, API keys, Codex or Claude CLI login files, SSH keys, private conversations or a Workspace data folder in an issue, a pull request, a commit or a log.

## Fixes and releases

A fix goes into `main` and reaches users in a later Core release. Older releases are not patched separately.

## What Yuzuno does and does not protect

These are the current design limits, documented where each feature is described:

- **Core has no user accounts.** It listens on loopback only, and anyone who can reach its port can use the Workspace. Reach it from another computer only through an SSH tunnel, never through a LAN or public port. See [Connect from another computer](independent-core.md#connect-from-another-computer).
- **Agents and Jobs run with the rights of the Core's operating-system user.** Jobs run outside the Agent sandbox, and their cgroup limits control resources rather than isolate processes. See [how Jobs are limited on Linux](macos-core.md#jobs-the-linux-backend-has-no-macos-counterpart-yet).
- **CI runs on GitHub-hosted runners** with a read-only token and no secrets, for pull requests from forks too. A first-time contributor's run waits for a maintainer's approval. See [CI](pr-ci-runner.md) and [Pull requests from forks](../CONTRIBUTING.md#pull-requests-from-forks).
