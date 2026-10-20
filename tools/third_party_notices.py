#!/usr/bin/env python3
"""Third-party notices for the Core binaries (T-90).

Lists the crates linked into bin/yuzuno-workspace and bin/yuzuno-update-helper
for one target, from Cargo.lock as cargo resolves a release build of them
(cargo tree: normal dependencies, default features, no proc macros). Each crate
is listed with the license its Cargo.toml declares and the license texts its
package ships, reproduced as they are. Crates used only while compiling
(build scripts, proc macros and what they use) are listed by name and declared
license only; their code is not in the binaries. Nothing is chosen, inferred
or filled in: a crate that ships no license text is listed as such.

The binaries also contain the Rust standard library. Its notices are the
toolchain's own COPYRIGHT-library.html (part of the rustc component), copied
as rust-std-COPYRIGHT-library.html.

Writes OUT/THIRD_PARTY_NOTICES-core.txt and OUT/rust-std-COPYRIGHT-library.html.
Runs offline; the crates' sources must already be present (any build or
`cargo fetch` with this Cargo.lock).
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = 'yuzuno-workspace'
LICENSE_FILE = re.compile(r'^(licen[cs]e|copying|notice|copyright|unlicense)([-._]|$)', re.I)
TREE_LINE = re.compile(r'^(\S+) v(\S+)')


def cargo(*args):
    return subprocess.run(['cargo', *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout


def tree(target, edges, package=PACKAGE, manifest=None):
    """(name, version) of every package in the release build's graph."""
    where = ('--manifest-path', str(manifest)) if manifest else ()
    out = cargo('tree', '--locked', '--offline', '-p', package, *where, '--target', target, '-e', edges,
                '--prefix', 'none', '-f', '{p}')
    found = set()
    for line in out.splitlines():
        match = TREE_LINE.match(line.strip())
        if match:
            found.add((match.group(1), match.group(2)))
    return found


def license_texts(package):
    """The license texts a crate's package ships: top-level license, notice and
    copyright files, and its Cargo.toml `license-file` if it names another."""
    root = Path(package['manifest_path']).parent
    names = sorted(p.name for p in root.iterdir() if p.is_file() and LICENSE_FILE.match(p.name))
    declared = package.get('license_file')
    if declared and Path(declared).name not in names and (root / declared).is_file():
        names.append(declared)
    return [(name, (root / name).read_text(errors='replace')) for name in names]


def notices(target, linked, compile_only, packages, rustc):
    by_key = {(p['name'], p['version']): p for p in packages}

    def third_party(keys):
        return sorted((by_key[k] for k in keys if by_key[k]['source'] is not None),
                      key=lambda p: (p['name'], p['version']))

    shipped, build_only = third_party(linked), third_party(compile_only - linked)
    texts, lines, missing = {}, [], []
    title = 'Third-party software in the Yuzuno Core binaries'
    lines += [title, '=' * len(title), '',
              'bin/yuzuno-workspace and bin/yuzuno-update-helper contain code from the',
              'Rust crates below and from the Rust standard library. They are the crates',
              f'of a release build for {target},',
              'with default features, from Cargo.lock (tools/third_party_notices.py);',
              'other targets or features may use other crates. Each crate keeps its own',
              'license. Where a crate offers a choice of licenses, every text it ships',
              'is reproduced and no choice is made here.',
              '',
              f'Rust standard library: {rustc}; its notices are in',
              'rust-std-COPYRIGHT-library.html next to this file.',
              'The project\'s own license is LICENSE next to this file. The web UI, the',
              'result validator and the Claude runtime carry their own notices:',
              'web/licenses/, runtimes/result-validator/THIRD_PARTY_NOTICES.txt, and the',
              'files of each package under runtimes/claude/node_modules/.',
              '', f'Crates in the binaries ({len(shipped)})', '']
    for p in shipped:
        refs = []
        for name, text in license_texts(p):
            key = hashlib.sha256(text.encode()).hexdigest()
            entry = texts.setdefault(key, {'number': len(texts) + 1, 'text': text, 'from': []})
            entry['from'].append(f"{p['name']} {p['version']} {name}")
            refs.append(f"[{entry['number']}] {name}")
        if not refs:
            missing.append(p)
        lines += [f"{p['name']} {p['version']}", f"  License (as declared): {p.get('license') or 'none declared'}",
                  f"  Source: {p['source']}", f"  Repository: {p.get('repository') or 'not declared'}",
                  f"  License texts: {', '.join(refs) if refs else 'none shipped in the package'}", '']
    if missing:
        lines += ['These crates ship no license text; only their declared license is listed above:',
                  *(f"  {p['name']} {p['version']} ({p.get('license') or 'none declared'})" for p in missing), '']
    lines += [f'Crates used only while compiling, not part of the binaries ({len(build_only)})', '',
              *(f"{p['name']} {p['version']}: {p.get('license') or 'none declared'}" for p in build_only), '',
              f'License texts ({len(texts)})', '']
    for entry in texts.values():
        lines += ['-' * 78, f"[{entry['number']}] from:", *(f'  {source}' for source in entry['from']), '',
                  entry['text'].rstrip(), '']
    return '\n'.join(lines) + '\n', {'crates': len(shipped), 'compileOnly': len(build_only), 'texts': len(texts),
                                     'withoutText': [f"{p['name']} {p['version']}" for p in missing]}


def generate(target, out):
    linked = tree(target, 'normal,no-proc-macro')
    compile_all = tree(target, 'normal,build')
    metadata = json.loads(cargo('metadata', '--locked', '--offline', '--format-version', '1', '--filter-platform', target))
    rustc = subprocess.run(['rustc', '--version'], check=True, capture_output=True, text=True).stdout.strip()
    sysroot = subprocess.run(['rustc', '--print', 'sysroot'], check=True, capture_output=True, text=True).stdout.strip()
    std = Path(sysroot) / 'share/doc/rust/COPYRIGHT-library.html'
    if not std.is_file():
        raise ValueError(f'The toolchain has no {std}; the standard library notices cannot be included')
    text, summary = notices(target, linked, compile_all, metadata['packages'], rustc)
    out.mkdir(parents=True, exist_ok=True)
    (out / 'THIRD_PARTY_NOTICES-core.txt').write_text(text)
    shutil.copyfile(std, out / 'rust-std-COPYRIGHT-library.html')
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--target', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(generate(args.target, args.out)))
