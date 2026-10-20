#!/usr/bin/env python3
"""Third-party notices for the Windows desktop app and its installer (T-90).

yuzuno-desktop.exe is a release build of desktop/Cargo.lock for
x86_64-pc-windows-msvc. Its crates are listed as tools/third_party_notices.py
lists Core's (cargo tree: normal dependencies, default features, no proc
macros), each with its declared license and the texts its package ships.

What ships without a license text in any crate gets the texts recorded in
tools/desktop-license-sources/sources.json:
- Microsoft's WebView2 loader, which webview2-com-sys links statically. Its
  texts are used only while that crate has the recorded version and file
  hash; a linked crate the record does not match is refused.
- The installer's own code (NSIS, the nsis_tauri_utils plug-in and Tauri's
  installer script). scripts/desktop.ps1 checks the files of the NSIS folder
  the Tauri CLI bundles with against the recorded hashes, before and after
  it bundles.

The Rust standard library's notices come from the toolchain that builds the
app: scripts/desktop.ps1 copies them next to these files.

Writes OUT/THIRD_PARTY_NOTICES-desktop.txt, OUT/LICENSE (the project's) and
OUT/notices.json, which scripts/desktop.ps1 checks before bundling. Runs
offline; the crates' sources must already be present
(`cargo fetch --manifest-path desktop/Cargo.toml`).
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil

# Core's generator, for its cargo tree reading and crate license texts.
_spec = importlib.util.spec_from_file_location('third_party_notices', Path(__file__).with_name('third_party_notices.py'))
core = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(core)

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'desktop/Cargo.toml'
PACKAGE = 'yuzuno-desktop'
TARGET = 'x86_64-pc-windows-msvc'
SOURCES = Path(__file__).resolve().parent / 'desktop-license-sources'
NOTICES = 'THIRD_PARTY_NOTICES-desktop.txt'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def recorded(folder=SOURCES):
    """sources.json, each text read from the folder and checked against its
    SHA-256 (a missing or changed text is refused)."""
    folder = Path(folder).resolve()
    index = json.loads((folder / 'sources.json').read_text())
    for entry in index['linked'] + index['installer']:
        entry['bodies'] = []
        for text in entry['texts']:
            file = (folder / text['file']).resolve()
            if file.parent != folder or not file.is_file():
                raise ValueError(f"The recorded text {text['file']} for {entry['name']} is not in {folder}")
            raw = file.read_bytes()
            if sha256(raw) != text['sha256']:
                raise ValueError(f"The recorded text {text['file']} for {entry['name']} does not match its SHA-256")
            entry['bodies'].append((text['file'], raw.decode()))
    return index


def linked_records(index, shipped):
    """The linked entries whose crate is in the app, each checked against the
    crate's own file. A crate the record names but does not match is refused:
    its code would ship without the texts."""
    by_name = {}
    for p in shipped:
        by_name.setdefault(p['name'], []).append(p)
    used = []
    for entry in index['linked']:
        for p in by_name.get(entry['crate'], []):
            file = Path(p['manifest_path']).parent / entry['file']
            actual = sha256(file.read_bytes()) if file.is_file() else None
            if p['version'] != entry['version'] or actual != entry['fileSha256']:
                raise ValueError(
                    f"{p['name']} {p['version']} links {entry['name']}, whose texts are recorded only for "
                    f"{entry['crate']} {entry['version']} with {entry['file']} at SHA-256 {entry['fileSha256']} "
                    f"(this one: {actual or 'missing'}); trace it again in {SOURCES.name}")
            used.append(entry)
    return used


def notices(shipped, build_only, index):
    texts, lines, missing = {}, [], []

    def reference(name, text, source):
        key = sha256(text.encode())
        entry = texts.setdefault(key, {'number': len(texts) + 1, 'text': text, 'from': []})
        entry['from'].append(source)
        return f"[{entry['number']}] {name}"

    def shipped_text(entry, dep, text):
        # A recorded dependency's text must be one the app's crates ship.
        if text['sha256'] not in texts:
            raise ValueError(f"{entry['name']} links {dep['crate']} {dep['version']}, whose {text['file']} (SHA-256 "
                             f"{text['sha256']}) no crate of the app ships; trace it again in {SOURCES.name}")
        texts[text['sha256']]['from'].append(f"{entry['name']}: {dep['crate']} {dep['version']} {text['file']}")
        return f"[{texts[text['sha256']]['number']}] {text['file']}"

    title = 'Third-party software in the Yuzuno desktop app for Windows'
    lines += [title, '=' * len(title), '',
              'yuzuno-desktop.exe contains code from the Rust crates below, from',
              "Microsoft's WebView2 loader and from the Rust standard library. They are",
              f'those of a release build for {TARGET}, with default',
              'features, from desktop/Cargo.lock (tools/desktop_notices.py). The installer',
              "that put it here was made with NSIS, the nsis_tauri_utils plug-in and Tauri's",
              'installer script. Each keeps its own license. Where a crate offers a choice',
              'of licenses, every text it ships is reproduced and no choice is made here.',
              '',
              "The Rust standard library's notices are in rust-std-COPYRIGHT-library.html",
              "next to this file, from the toolchain that built the app. The project's own",
              'license is LICENSE next to this file.',
              '', f'Crates in the app ({len(shipped)})', '']
    for p in shipped:
        refs = [reference(name, text, f"{p['name']} {p['version']} {name}") for name, text in core.license_texts(p)]
        if not refs:
            missing.append(p)
        lines += [f"{p['name']} {p['version']}", f"  License (as declared): {p.get('license') or 'none declared'}",
                  f"  Source: {p['source']}", f"  Repository: {p.get('repository') or 'not declared'}",
                  f"  License texts: {', '.join(refs) if refs else 'none shipped in the package'}", '']
    if missing:
        lines += ['These crates ship no license text; only their declared license is listed above:',
                  *(f"  {p['name']} {p['version']} ({p.get('license') or 'none declared'})" for p in missing), '']
    linked = linked_records(index, shipped)
    lines += [f'Recorded texts for code that ships without one ({len(linked) + len(index["installer"])})',
              '(tools/desktop-license-sources, with how each was traced)', '']
    for entry in linked:
        up = entry['upstream']
        refs = [reference(name, text, f"{up['package']} {up['version']} {name}") for name, text in entry['bodies']]
        lines += [entry['name'],
                  f"  Linked by: {entry['crate']} {entry['version']} ({entry['file']})",
                  f"  From: {up['package']} {up['version']}, {up['path']} (the same bytes)",
                  f"  License texts: {', '.join(refs)}", '']
    for entry in index['installer']:
        refs = [reference(name, text, f"{entry['name']} {name}") for name, text in entry['bodies']]
        lines += [entry['name'], f"  In the installer: {entry['role']}", f"  License texts: {', '.join(refs)}"]
        crates = [f"    {dep['crate']} {dep['version']}: {', '.join(shipped_text(entry, dep, text) for text in dep['texts'])}"
                  for dep in entry.get('dependencies', [])]
        if crates:
            lines += ['  Its Rust crates (versions inferred; see tools/desktop-license-sources):', *crates]
        lines += [f'  Note: {entry["note"]}'] if entry.get('note') else []
        lines.append('')
    lines += [f'Crates used only while compiling, not part of the app ({len(build_only)})', '',
              *(f"{p['name']} {p['version']}: {p.get('license') or 'none declared'}" for p in build_only), '',
              f'License texts ({len(texts)})', '']
    for entry in texts.values():
        lines += ['-' * 78, f"[{entry['number']}] from:", *(f'  {source}' for source in entry['from']), '',
                  entry['text'].rstrip(), '']
    return '\n'.join(lines) + '\n', {'crates': len(shipped), 'compileOnly': len(build_only), 'texts': len(texts),
                                     'withoutText': [f"{p['name']} {p['version']}" for p in missing],
                                     'recorded': [e['name'] for e in linked] + [e['name'] for e in index['installer']]}


def generate(out, sources=SOURCES):
    index = recorded(sources)
    linked = core.tree(TARGET, 'normal,no-proc-macro', PACKAGE, MANIFEST)
    compile_all = core.tree(TARGET, 'normal,build', PACKAGE, MANIFEST)
    metadata = json.loads(core.cargo('metadata', '--locked', '--offline', '--format-version', '1',
                                     '--manifest-path', str(MANIFEST), '--filter-platform', TARGET))
    by_key = {(p['name'], p['version']): p for p in metadata['packages']}

    def third_party(keys):
        return sorted((by_key[k] for k in keys if by_key[k]['source'] is not None),
                      key=lambda p: (p['name'], p['version']))

    text, summary = notices(third_party(linked), third_party(compile_all - linked), index)
    out.mkdir(parents=True, exist_ok=True)
    (out / NOTICES).write_text(text)
    shutil.copyfile(ROOT / 'LICENSE', out / 'LICENSE')
    record = {'target': TARGET, 'cargoLockSha256': sha256((ROOT / 'desktop/Cargo.lock').read_bytes()),
              'files': {name: sha256((out / name).read_bytes()) for name in (NOTICES, 'LICENSE')},
              # What desktop.ps1 checks in the Tauri CLI's NSIS folder.
              'installer': [{'name': e['name'], **({'files': e['files']} if 'files' in e else {}),
                             **({'cli': e['cli']} if 'cli' in e else {})} for e in index['installer']],
              **summary}
    (out / 'notices.json').write_text(json.dumps(record, indent=1) + '\n')
    return record


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(generate(args.out)))
