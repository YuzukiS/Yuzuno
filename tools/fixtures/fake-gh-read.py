#!/usr/bin/env python3
"""A read-only stand-in for `gh` (YN-54), put on PATH as `gh` by
tools/test_release_run.py and by the dry run in docs/core-release-checklist.md.

Every call is appended to the JSON-lines file FAKE_GH_LOG with its verdict:
- "read": `gh api` with no --method other than GET and, without --method GET,
  no field or input (-f, -F, --field, --raw-field, --input);
- "write": any other `gh api` call;
- "refused": anything else, and every write that no reply accepts.

A refused call sends nothing and exits 1 with "fake gh: refused" on stderr.

Replies:
- A read is answered from FAKE_GH_READS, a JSON file mapping an endpoint to
  {"json": value}, {"file": path} (its bytes) or {"status": 404}; an endpoint
  it doesn't list exits 1, naming it.
- With FAKE_GH_PASSTHROUGH set to the real gh, a read is passed to it
  unchanged instead, and every write is refused: a dry run against GitHub
  that cannot change it.
- A test accepts the writes it expects in FAKE_GH_WRITES, a JSON file mapping
  "METHOD endpoint" to {"json": value}.
"""
import json
import os
from pathlib import Path
import sys

TAKES_VALUE = {'-H', '--header', '-X', '--method', '-f', '--raw-field', '-F', '--field', '--input', '-q', '--jq',
               '-t', '--template', '--hostname', '--cache', '-p', '--preview'}
FIELDS = {'-f', '--raw-field', '-F', '--field', '--input'}


def parse(args):
    """(method, endpoint, fields) of a `gh api` call."""
    method, endpoint, fields, rest = None, None, [], list(args[1:])
    while rest:
        arg = rest.pop(0)
        if arg in TAKES_VALUE:
            value = rest.pop(0) if rest else ''
            if arg in ('-X', '--method'):
                method = value.upper()
            elif arg in FIELDS:
                fields.append(value)
        elif arg.startswith('-'):
            continue
        elif endpoint is None:
            endpoint = arg
    return method, endpoint, fields


def main():
    args = sys.argv[1:]
    verdict, method, endpoint, fields = 'refused', None, None, []
    if args[:1] == ['api']:
        method, endpoint, fields = parse(args)
        verdict = 'read' if method in (None, 'GET') and (method == 'GET' or not fields) else 'write'
        method = method or ('POST' if fields else 'GET')
    passthrough = os.environ.get('FAKE_GH_PASSTHROUGH')
    replies = {}
    if verdict == 'write' and not passthrough and os.environ.get('FAKE_GH_WRITES'):
        replies = json.loads(Path(os.environ['FAKE_GH_WRITES']).read_text())
    if verdict == 'write' and f'{method} {endpoint}' not in replies:
        verdict = 'refused'
    with open(os.environ['FAKE_GH_LOG'], 'a') as log:
        log.write(json.dumps({'argv': args, 'verdict': verdict, 'method': method, 'endpoint': endpoint, 'fields': fields}) + '\n')
    if verdict == 'refused':
        print(f'fake gh: refused {" ".join(args)}', file=sys.stderr)
        sys.exit(1)
    if verdict == 'write':
        print(json.dumps(replies[f'{method} {endpoint}']['json']))
        return
    if passthrough:
        os.execv(passthrough, [passthrough, *args])
    reads = json.loads(Path(os.environ['FAKE_GH_READS']).read_text())
    if endpoint not in reads:
        print(f'fake gh: no reply for {endpoint}', file=sys.stderr)
        sys.exit(1)
    reply = reads[endpoint]
    if reply.get('status') == 404:
        print(json.dumps({'message': 'Not Found', 'status': '404'}))
        print('gh: Not Found (HTTP 404)', file=sys.stderr)
        sys.exit(1)
    if 'file' in reply:
        sys.stdout.buffer.write(Path(reply['file']).read_bytes())
        return
    print(json.dumps(reply['json']))


if __name__ == '__main__':
    main()
