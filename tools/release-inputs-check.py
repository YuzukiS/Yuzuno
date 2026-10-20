#!/usr/bin/env python3
"""Checks the release inputs the release-inputs workflow is about to upload
(T-159): built from this run's commit, repository, run and attempt, the
archive is the one build.json describes, and no file belongs to the Claude
Agent SDK. Prints each problem and exits 1 if there is any."""
import argparse
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_common import claude_sdk_files, digest, read


def problems(product, env):
    build = read(product / 'build.json')
    found = []
    for key, variable in [('source', 'GITHUB_SHA'), ('repository', 'GITHUB_REPOSITORY'),
                          ('runId', 'GITHUB_RUN_ID'), ('runAttempt', 'GITHUB_RUN_ATTEMPT')]:
        expected = env.get(variable)
        if not expected or str(build.get(key)) != expected:
            found.append(f'build.json {key} is {build.get(key)!r}, not {variable} {expected!r}')
    if digest(product / 'inputs.tar.gz') != build.get('archiveSha256'):
        found.append('inputs.tar.gz is not the archive build.json describes')
    sdk = claude_sdk_files(build.get('files', {}))
    if sdk:
        found.append(f'the inputs carry the Claude Agent SDK: {len(sdk)} files, for example {sdk[0]}')
    return found


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('product', type=Path, help='The directory with build.json and inputs.tar.gz')
    found = problems(parser.parse_args().product, os.environ)
    for problem in found:
        print(f'::error::{problem}')
    sys.exit(1 if found else 0)
