#!/usr/bin/env python3
"""A small research stage for the run acceptance: it records that it started,
reads its upstream files, records usage, then produces its artifact or fails
as asked. No model, no training, no network."""
import argparse
import json
import os
import pathlib
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--log', required=True, help='start log (one JSON line per start)')
parser.add_argument('--out', help='the artifact this stage writes')
parser.add_argument('--mode', default='ok', choices=['ok', 'fail', 'no-output', 'partial', 'fail-if-flag'])
parser.add_argument('--sleep', type=float, default=0)
parser.add_argument('--read', action='append', default=[], help='upstream JSON files to read')
parser.add_argument('--usd', type=float, action='append', default=[], help='usage entries of known cost')
parser.add_argument('--unknown-usage', type=int, default=0, help='usage entries of unknown cost')
parser.add_argument('--fail-attempts', type=int, default=0, help='exit 75 (retryable) on attempts up to this')
args = parser.parse_args()

attempt = int(os.environ.get('YUZUNO_RUN_ATTEMPT', '1'))
with open(args.log, 'a') as log:
    log.write(json.dumps({'attempt': attempt, 'job': os.environ.get('YUZUNO_JOB_ID'),
                          'stage': os.environ.get('YUZUNO_RUN_STAGE')}) + '\n')

# Usage is recorded per call as it happens, before the outcome is known.
usage = os.environ.get('YUZUNO_JOB_USAGE_FILE')
if usage:
    with open(usage, 'a') as f:
        for usd in args.usd:
            f.write(json.dumps({'usd': usd, 'source': 'fixture provider usage'}) + '\n')
        for _ in range(args.unknown_usage):
            f.write(json.dumps({'usd': None, 'source': 'fixture: response lost'}) + '\n')

progress = os.environ.get('YUZUNO_JOB_PROGRESS_FILE')
steps = max(1, int(args.sleep * 2))
for step in range(steps if args.sleep else 0):
    if progress:
        tmp = pathlib.Path(progress + '.tmp')
        tmp.write_text(json.dumps({'step': step + 1, 'of': steps}))
        tmp.replace(progress)
    time.sleep(args.sleep / steps)

inputs = [json.loads(pathlib.Path(path).read_text()) for path in args.read]
if attempt <= args.fail_attempts:
    sys.exit(75)
if args.mode == 'fail':
    sys.exit(3)
if args.mode == 'no-output':
    sys.exit(1)
if args.mode == 'fail-if-flag' and pathlib.Path('flag-' + args.log).exists():
    sys.exit(4)
out = pathlib.Path(args.out)
if args.mode == 'partial':
    out.write_text('{"return": 1, "steps": ')
    sys.exit(0)
config = json.loads(pathlib.Path('config.json').read_text())
tmp = pathlib.Path(args.out + '.tmp')
tmp.write_text(json.dumps({'return': config['seed'] * 2, 'inputs': inputs}))
tmp.replace(out)
