#!/usr/bin/env python3
"""Third-party notices for the Claude runtime in the Core release bundle (T-90).

tools/build-core-artifact.py installs runtimes/claude with
`npm ci --omit=dev --omit=optional` and copies the result into the bundle as
runtimes/claude/. This first checks that the installed node_modules is exactly
the lock file's production set: every package path, name and version, with
nothing missing and nothing extra. It then writes notices for those packages.
Each one is listed with the license its package.json declares and the license
texts it ships, reproduced as they are; a declared "SEE LICENSE IN <file>"
names one more text. Nothing is chosen, inferred or filled in, and a package
that ships no license text is listed as such.

The one exception is recorded, never looked up: for a package that ships no
license text, tools/runtime-license-sources/sources.json may name the license
text of its exact source (for example the commit its npm provenance names).
That text is reproduced, marked as not shipped in the package, only for the
recorded name, version and lock integrity, and only if its SHA-256 matches;
for any other version the package stays listed without a text. Nothing is
fetched over the network.

The Claude Agent SDK is checked against the lock like the others but is not
shipped (T-159): Core obtains it on the user's machine. It is listed with its
declared license, source and integrity, and none of its texts is reproduced.

Usage: runtime_notices.py --runtime DIR --out FILE [--sources DIR]
(exits 1 on a mismatch).
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

LICENSE_FILE = re.compile(r'^(licen[cs]e|copying|notice|copyright|unlicense)([-._]|$)', re.I)
SEE_LICENSE = re.compile(r'^SEE LICENSE IN (\S+)$')
SOURCES = Path(__file__).resolve().parent / 'runtime-license-sources'
# Installed to check them, then left out of the release (claude_sdk_release).
OBTAINED_ON_THE_MACHINE = ('@anthropic-ai/claude-agent-sdk',)


def recorded_sources(folder):
    """{(name, version): entry} from sources.json, each entry's text read and
    checked against its recorded SHA-256 (a mismatch is refused)."""
    index = Path(folder) / 'sources.json'
    if not index.is_file():
        return {}
    out = {}
    for entry in json.loads(index.read_text())['packages']:
        file = (Path(folder) / entry['text']).resolve()
        if file.parent != Path(folder).resolve() or not file.is_file():
            raise ValueError(f"The recorded license text for {entry['name']} {entry['version']} is not in {folder}")
        raw = file.read_bytes()
        if hashlib.sha256(raw).hexdigest() != entry['textSha256']:
            raise ValueError(f"The recorded license text for {entry['name']} {entry['version']} "
                             f"does not match its recorded SHA-256")
        out[(entry['name'], entry['version'])] = {**entry, 'body': raw.decode()}
    return out


def expected(lock):
    """{path: (name, version)} for the lock file's production packages."""
    out = {}
    for path, entry in lock['packages'].items():
        if not path or entry.get('dev') or entry.get('optional') or entry.get('devOptional') or entry.get('link'):
            continue
        out[path] = (entry.get('name') or path.rsplit('node_modules/', 1)[1], entry.get('version'))
    return out


def installed(runtime):
    """{path: (name, version)} for every package under node_modules, nested ones included."""
    out = {}

    def scan(modules):
        if not modules.is_dir():
            return
        for child in sorted(modules.iterdir()):
            if child.name.startswith('.'):
                continue
            dirs = sorted(child.iterdir()) if child.name.startswith('@') and child.is_dir() else [child]
            for package in dirs:
                manifest = package / 'package.json'
                if not manifest.is_file():
                    continue
                data = json.loads(manifest.read_text())
                out[package.relative_to(runtime).as_posix()] = (data.get('name'), data.get('version'))
                scan(package / 'node_modules')

    scan(runtime / 'node_modules')
    return out


def problems(want, have):
    found = []
    for path in sorted(want.keys() - have.keys()):
        found.append(f'missing: {path} {want[path][1]}')
    for path in sorted(have.keys() - want.keys()):
        found.append(f'not a production package of the lock file: {path} {have[path][1]}')
    for path in sorted(want.keys() & have.keys()):
        if want[path] != have[path]:
            found.append(f'differs from the lock file: {path} is {have[path][0]} {have[path][1]}, '
                         f'locked {want[path][0]} {want[path][1]}')
    return found


def declared(manifest):
    value = manifest.get('license')
    if isinstance(value, str):
        return value
    if isinstance(value, dict) and isinstance(value.get('type'), str):
        return value['type']
    if isinstance(manifest.get('licenses'), list):
        return 'listed in the legacy "licenses" field: ' + ', '.join(
            str(item.get('type') if isinstance(item, dict) else item) for item in manifest['licenses'])
    return 'none declared'


def license_texts(package, license):
    names = sorted(p.name for p in package.iterdir() if p.is_file() and LICENSE_FILE.match(p.name))
    see = SEE_LICENSE.match(license)
    if see and see.group(1) not in names and (package / see.group(1)).is_file():
        names.append(see.group(1))
    return [(name, (package / name).read_text(errors='replace')) for name in names]


def notices(runtime, have, lock=None, sources=None):
    lock, sources = lock or {'packages': {}}, sources or {}
    texts, lines, missing, traced, unmatched, seen = {}, [], [], [], [], set()
    title = 'Third-party software in the Yuzuno Claude runtime'
    lines += [title, '=' * len(title), '',
              'runtimes/claude/ contains the npm packages below: the production',
              'dependencies of runtimes/claude/package-lock.json, as `npm ci --omit=dev',
              '--omit=optional` installs them for the release (tools/runtime_notices.py',
              'checked every path and version against the lock file). Each package keeps',
              'its own license. The Claude Agent SDK is not in the release: Core obtains',
              'it on the user\'s machine from the source its entry names, checked against',
              'the locked integrity; it is under Anthropic\'s terms, as its package',
              'declares, and none of its texts is reproduced here. Where a package offers',
              'a choice of licenses, every text it ships is reproduced and no choice is',
              'made here. A package that ships no license text is reproduced with the',
              'text of its exact source only where that is recorded in',
              'tools/runtime-license-sources (with its evidence), and is marked as not',
              'shipped in the package.',
              '', f'Packages ({len(have)})', '']
    for path in sorted(have, key=lambda p: (have[p][0], have[p][1], p)):
        name, version = have[path]
        manifest = json.loads((runtime / path / 'package.json').read_text())
        license = declared(manifest)
        repository = manifest.get('repository')
        repository = repository.get('url') if isinstance(repository, dict) else repository
        if name in OBTAINED_ON_THE_MACHINE:
            locked = lock['packages'].get(path, {})
            lines += [f'{name} {version}' + ('' if path == f'node_modules/{name}' else f' (at {path})'),
                      f'  License (as declared): {license}',
                      f"  Repository: {repository or manifest.get('homepage') or 'not declared'}",
                      f"  Not in this release: Core obtains it on the user's machine from "
                      f"{locked.get('resolved', 'the registry')}, checked against {locked.get('integrity', 'its locked integrity')}", '']
            continue
        refs = []
        for file, text in license_texts(runtime / path, license):
            key = hashlib.sha256(text.encode()).hexdigest()
            entry = texts.setdefault(key, {'number': len(texts) + 1, 'text': text, 'from': []})
            entry['from'].append(f'{name} {version} {file}')
            refs.append(f"[{entry['number']}] {file}")
        record = sources.get((name, version))
        if record:
            seen.add((name, version))
        if record and refs:
            unmatched.append(f'{name} {version}: the package ships its own license text')
        elif record:
            locked = lock['packages'].get(path, {}).get('integrity')
            if locked == record['integrity']:
                up = record['upstream']
                label = f"{up['path']} at {up['repository']} {up['commit']} (its source; not shipped in the package)"
                key = hashlib.sha256(record['body'].encode()).hexdigest()
                entry = texts.setdefault(key, {'number': len(texts) + 1, 'text': record['body'], 'from': []})
                entry['from'].append(f'{name} {version} {label}')
                refs.append(f"[{entry['number']}] from {label}")
                traced.append(f'{name} {version}')
            else:
                unmatched.append(f'{name} {version}: the recorded text is for integrity {record["integrity"]}, '
                                 f'the lock has {locked}')
        if not refs:
            missing.append((name, version, license))
        lines += [f'{name} {version}' + ('' if path == f'node_modules/{name}' else f' (at {path})'),
                  f'  License (as declared): {license}',
                  f"  Repository: {repository or manifest.get('homepage') or 'not declared'}",
                  f"  License texts: {', '.join(refs) if refs else 'none shipped in the package'}", '']
    if missing:
        lines += ['These packages ship no license text; only their declared license is listed above:',
                  *(f'  {name} {version} ({license})' for name, version, license in missing), '']
    lines += [f'License texts ({len(texts)})', '']
    for entry in texts.values():
        lines += ['-' * 78, f"[{entry['number']}] from:", *(f'  {source}' for source in entry['from']), '',
                  entry['text'].rstrip(), '']
    unmatched += [f'{n} {v}: not a package of this install' for n, v in sorted(sources.keys() - seen)]
    return '\n'.join(lines) + '\n', {'packages': len(have), 'texts': len(texts),
                                     'withoutText': [f'{n} {v}' for n, v, _ in missing],
                                     'fromRecordedSource': traced, 'recordedSourceNotUsed': unmatched}


def generate(runtime, out, sources=SOURCES):
    runtime = Path(runtime)
    lock = json.loads((runtime / 'package-lock.json').read_text())
    have = installed(runtime)
    found = problems(expected(lock), have)
    if found:
        raise ValueError('The installed Claude runtime differs from its lock file:\n  ' + '\n  '.join(found))
    text, summary = notices(runtime, have, lock, recorded_sources(sources))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--sources', type=Path, default=SOURCES)
    args = parser.parse_args()
    try:
        print(json.dumps(generate(args.runtime, args.out, args.sources)))
    except ValueError as error:
        print(error, file=sys.stderr)
        sys.exit(1)
