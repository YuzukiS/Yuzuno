#!/usr/bin/env python3
"""A stand-in for `gh`, installed as `gh` on PATH by tools/test_release_flow.py.

It keeps one repository's tags and releases in the JSON file named by
FAKE_GH_STATE and records every invocation there. It answers only the calls
tools/core-release.py makes when it publishes, now and at ecee0a8 (`gh release
create/upload/edit`), the way gh v2.102.0 makes them: `gh api` prints the
reply and, for an HTTP error, the error body, with "gh: <message> (HTTP
<status>)" on stderr and exit status 1.

Faults, set by the test in state["faults"], are applied in this order:
  listHides: the next N release list reads omit releases created here.
  idHides: the next N reads by ID of a release created here answer 404.
  loseReply: operations ("create", "upload", "publish") whose next reply is
    lost: the change is made, nothing is printed, and gh exits 1.
  createSource: the target_commitish a created release reports.
  uploadUrlId: the release ID in every upload_url.
  uploadDigest: the digest a newly uploaded asset reports.
Nothing here reaches the network.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.parse


def fail(status, message):
    print(json.dumps({'message': message, 'status': str(status)}))
    print(f'gh: {message} (HTTP {status})', file=sys.stderr)
    sys.exit(1)


def magic(value):
    # gh's -F: @file, integers, true/false/null, else the string.
    if value.startswith('@'):
        return Path(value[1:]).read_text()
    if value.lstrip('-').isdigit():
        return int(value)
    return {'true': True, 'false': False, 'null': None}.get(value, value)


def main():
    path = Path(os.environ['FAKE_GH_STATE'])
    state = json.loads(path.read_text())
    args = sys.argv[1:]
    faults = state['faults']
    repo = state['repository']

    def save():
        path.write_text(json.dumps(state, indent=1))

    state['calls'].append(args)
    save()

    def lose(operation):
        if operation in faults.get('loseReply', []):
            faults['loseReply'].remove(operation)
            save()
            print('error connecting to api.github.com', file=sys.stderr)
            sys.exit(1)

    def reply(value, operation=None):
        save()
        lose(operation)
        print(json.dumps(value))
        sys.exit(0)

    def shown(release):
        value = {k: v for k, v in release.items() if not k.startswith('_')}
        upload_id = faults.get('uploadUrlId', release['id'])
        value['upload_url'] = f'https://uploads.github.com/repos/{repo}/releases/{upload_id}/assets{{?name,label}}'
        value['html_url'] = (f"https://github.com/{repo}/releases/tag/untagged-{release['_untagged']}" if release['draft']
                             else f"https://github.com/{repo}/releases/tag/{release['tag_name']}")
        return value

    def by_id(number, read=False):
        for release in state['releases']:
            if release['id'] == number:
                if read and release.get('_new') and faults.get('idHides', 0) > 0:
                    faults['idHides'] -= 1
                    save()
                    fail(404, 'Not Found')
                return release
        fail(404, 'Not Found')

    def by_tag(tag):
        # gh release upload/edit: the published release, else a draft found by GraphQL.
        for published in (True, False):
            for release in state['releases']:
                if release['tag_name'] == tag and release['draft'] is not published:
                    return release
        print('release not found', file=sys.stderr)
        sys.exit(1)

    def create(fields):
        number = state['nextId']
        state['nextId'] += 1
        release = {'id': number, 'tag_name': fields['tag_name'],
                   'target_commitish': faults.get('createSource', fields.get('target_commitish')),
                   'name': fields.get('name'), 'body': fields.get('body'), 'draft': fields['draft'],
                   'prerelease': fields.get('prerelease', False), 'assets': [], '_new': True,
                   '_untagged': hashlib.sha256(str(number).encode()).hexdigest()[:20]}
        state['releases'].append(release)
        state['writes']['create'].append(fields)
        return release

    def upload(release, name, data, kind):
        if any(a['name'] == name for a in release['assets']):
            fail(422, 'Validation Failed')
        state['nextAsset'] += 1
        asset = {'id': state['nextAsset'], 'name': name, 'size': len(data), 'content_type': kind,
                 'digest': faults.pop('uploadDigest', 'sha256:' + hashlib.sha256(data).hexdigest())}
        release['assets'].append(asset)
        state['writes']['upload'].append(name)
        return asset

    if args[:2] == ['release', 'create']:
        rest = [a for a in args[3:] if a != '--draft']
        flags = dict(zip(rest[::2], rest[1::2]))
        release = create({'tag_name': args[2], 'target_commitish': flags['--target'], 'name': flags['--title'],
                          'body': Path(flags['--notes-file']).read_text(), 'draft': '--draft' in args, 'prerelease': False})
        save()
        lose('create')
        print(shown(release)['html_url'])
        return
    if args[:2] == ['release', 'upload']:
        release, data = by_tag(args[2]), Path(args[3]).read_bytes()
        upload(release, Path(args[3]).name, data, 'application/octet-stream')
        save()
        lose('upload')
        return
    if args[:2] == ['release', 'edit']:
        release = by_tag(args[2])
        release['draft'] = False
        state['writes']['publish'] += 1
        save()
        lose('publish')
        print(shown(release)['html_url'])
        return
    if args[0] != 'api':
        print(f'fake gh: unsupported command {args}', file=sys.stderr)
        sys.exit(2)

    method, headers, fields, endpoint, body = 'GET', {}, {}, None, None
    rest = args[1:]
    while rest:
        flag = rest.pop(0)
        if flag in ('--method', '-X'):
            method = rest.pop(0)
        elif flag == '-H':
            name, value = rest.pop(0).split(':', 1)
            headers[name.strip().lower()] = value.strip()
        elif flag == '-f':
            key, value = rest.pop(0).split('=', 1)
            fields[key] = value
        elif flag == '-F':
            key, value = rest.pop(0).split('=', 1)
            fields[key] = magic(value)
        elif flag == '--input':
            body = Path(rest.pop(0)).read_bytes()
        elif flag.startswith('-'):
            print(f'fake gh: unsupported flag {flag}', file=sys.stderr)
            sys.exit(2)
        else:
            endpoint = flag
    url = urllib.parse.urlsplit(endpoint)
    route = url.path.removeprefix('/').split('/')
    query = dict(urllib.parse.parse_qsl(url.query))
    base = ['repos', *repo.split('/')]
    if url.scheme == 'https':
        if url.netloc != 'uploads.github.com' or route[:3] != base or route[3] != 'releases' or route[5:] != ['assets'] or method != 'POST':
            fail(404, 'Not Found')
        release = by_id(int(route[4]))
        reply(upload(release, query['name'], body, headers.get('content-type')), 'upload')
    if route[:3] != base:
        fail(404, 'Not Found')
    route = route[3:]
    if method == 'GET' and route[:3] == ['git', 'ref', 'tags']:
        sha = state['refs'].get(route[3])
        if sha is None:
            fail(404, 'Not Found')
        reply({'ref': f'refs/tags/{route[3]}', 'object': {'type': 'commit', 'sha': sha}})
    if method == 'POST' and route == ['git', 'refs']:
        tag = fields['ref'].removeprefix('refs/tags/')
        if tag in state['refs']:
            fail(422, 'Reference already exists')
        state['refs'][tag] = fields['sha']
        state['writes']['tag'] += 1
        reply({'ref': fields['ref'], 'object': {'type': 'commit', 'sha': fields['sha']}})
    if method == 'GET' and route[:2] == ['releases', 'tags']:
        for release in state['releases']:
            if release['tag_name'] == route[2] and not release['draft']:
                reply(shown(release))
        fail(404, 'Not Found')
    if method == 'GET' and route == ['releases']:
        listed = state['releases']
        if faults.get('listHides', 0) > 0 and any(r.get('_new') for r in listed):
            faults['listHides'] -= 1
            listed = [r for r in listed if not r.get('_new')]
        page, size = int(query.get('page', 1)), int(query.get('per_page', 30))
        reply([shown(r) for r in listed[(page - 1) * size:page * size]])
    if method == 'GET' and len(route) == 2 and route[0] == 'releases':
        reply(shown(by_id(int(route[1]), read=True)))
    if method == 'POST' and route == ['releases']:
        reply(shown(create(fields)), 'create')
    if method == 'PATCH' and len(route) == 2 and route[0] == 'releases':
        release = by_id(int(route[1]))
        if fields != {'draft': False}:
            fail(422, 'Validation Failed')
        release['draft'] = False
        state['writes']['publish'] += 1
        reply(shown(release), 'publish')
    fail(404, 'Not Found')


if __name__ == '__main__':
    main()
