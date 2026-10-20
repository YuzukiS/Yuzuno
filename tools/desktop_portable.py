#!/usr/bin/env python3
"""Make the Windows desktop app's portable ZIP from a built installer (T-148).

  python3 tools/desktop_portable.py <...-setup.exe> --app <the built app .exe> \\
      --licenses desktop/licenses --version <version> --out <folder>

The ZIP carries the installer's own app. Each notices file must be, byte for
byte, a file the installer stores (read as tools/desktop_installer_check.py
reads it). So must --app, except for one marker: Tauri's bundler writes the
bundle type into the installer's copy of the app (NSS, NSIS) and leaves the
built app's as UNK (none). The portable copy keeps UNK: it was not installed by
an installer. It writes yuzuno-desktop-windows-x86_64-portable.zip, holding one
folder:

  <product> <version> portable/<product>.exe
  <product> <version> portable/README.txt    how to run, update and remove it
  <product> <version> portable/licenses/...  the installer's notices files

Product name and identifier come from desktop/tauri.conf.json, with --config
files merged over it as the Tauri CLI merges them (a lab identity). Entries are
sorted and dated 1980-01-01, so the same inputs make the same ZIP. Prints a
JSON report; exits 1 unless every check passed.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NAME = 'yuzuno-desktop-windows-x86_64-portable.zip'
STAMP = (1980, 1, 1, 0, 0, 0)
# Where Tauri records how the app was bundled (tauri-utils' bundle type).
MARKER = b'__TAURI_BUNDLE_TYPE_VAR_'

spec = importlib.util.spec_from_file_location('desktop_installer_check', Path(__file__).with_name('desktop_installer_check.py'))
installer_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer_check)

README = """{product} {version} for Windows, portable (no installer)

Unzip this folder anywhere you can write to, then run {exe}. When it starts,
it asks which Core to connect to.

Needs Windows 10 or 11 (x64) with the Microsoft Edge WebView2 Runtime, which
Windows normally includes. If {exe} does not open, install the runtime from
https://developer.microsoft.com/microsoft-edge/webview2/

Updates: this copy does not update itself. For a newer version, close
{product}, download the new portable ZIP and replace this folder's files with
its files. Or install {product} with its installer instead, which can update
itself from the app.

Your data is not in this folder:
- the Core it remembers: %APPDATA%\\{identifier}\\core.json
- the window's storage, including unsent drafts: %LOCALAPPDATA%\\{identifier}
An installed {product} uses the same folders, so both copies share them.
Moving or deleting this folder leaves them where they are.

To remove it, delete this folder. It adds no Start menu entry, shortcut or
Installed apps entry. To remove its data too, delete the two places above;
that also clears an installed {product}'s saved Core and drafts.

Licenses and third-party notices: the licenses folder.
"""


def installer_app(app, stored):
    """The installer stores this app: the same bytes but Tauri's bundle type,
    which is UNK in the app and NSS in the installer's copy."""
    at = app.find(MARKER)
    if at < 0 or app.find(MARKER, at + 1) >= 0 or app[at + len(MARKER):at + len(MARKER) + 3] != b'UNK':
        return False
    end = at + len(MARKER) + 3
    return any(len(block) == len(app) and block[:at] == app[:at] and block[at:end] == MARKER + b'NSS'
               and block[end:] == app[end:] for block in stored)


def merge(base, overlay):
    """JSON Merge Patch (RFC 7396), as the Tauri CLI applies --config files."""
    if not isinstance(overlay, dict):
        return overlay
    merged = dict(base) if isinstance(base, dict) else {}
    for key, value in overlay.items():
        if value is None:
            merged.pop(key, None)
        else:
            merged[key] = merge(merged.get(key), value)
    return merged


def identity(configs):
    config = json.loads((ROOT / 'desktop/tauri.conf.json').read_text())
    for path in configs:
        config = merge(config, json.loads(Path(path).read_text()))
    product, identifier = config.get('productName'), config.get('identifier')
    if not (isinstance(product, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9 ._-]*', product)
            and isinstance(identifier, str) and re.fullmatch(r'[A-Za-z0-9.-]+', identifier)):
        raise ValueError('the Tauri config needs a plain productName and identifier')
    return product, identifier


def build(installer, app, licenses, version, out, configs=()):
    report = {'installer': {'path': str(Path(installer).resolve())}, 'checks': [], 'passed': False}

    def check(name, ok, **details):
        report['checks'].append({'name': name, 'ok': bool(ok), **details})
        if not ok:
            raise ValueError(name)

    try:
        check('the version is plain semver', re.fullmatch(r'\d+\.\d+\.\d+', version), version=version)
        named = re.search(r'_(\d+\.\d+\.\d+)_x64-setup\.exe$', Path(installer).name)
        check("the installer's file name, if it has one, names that version", not named or named[1] == version,
              file=Path(installer).name)
        product, identifier = identity(configs)
        report.update(product=product, identifier=identifier, version=version)
        data = Path(installer).read_bytes()
        report['installer']['sha256'] = hashlib.sha256(data).hexdigest()
        stored, _ = installer_check.blocks(data)
        digests = {hashlib.sha256(block).hexdigest() for block in stored}
        app_bytes = Path(app).read_bytes()
        app_sha = hashlib.sha256(app_bytes).hexdigest()
        check('--app is a Windows executable', app_bytes[:2] == b'MZ')
        check("--app is the installer's app, with no bundle type (UNK) where the installer's copy has NSIS",
              installer_app(app_bytes, stored), sha256=app_sha)
        files = {}
        for name in installer_check.SHIPPED:
            path = Path(licenses) / name
            check(f'the licenses folder has {name}', path.is_file())
            files[name] = path.read_bytes()
            sha = hashlib.sha256(files[name]).hexdigest()
            check(f'{name} is, byte for byte, the one the installer stores', sha in digests, sha256=sha)
    except ValueError as error:
        report['refused'] = str(error)
        return report

    folder = f'{product} {version} portable'
    exe = f'{product}.exe'
    entries = {f'{folder}/{exe}': app_bytes,
               f'{folder}/README.txt': README.format(product=product, version=version, exe=exe,
                                                     identifier=identifier).replace('\n', '\r\n').encode(),
               **{f'{folder}/licenses/{name}': data for name, data in files.items()}}
    target = Path(out) / NAME
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, 'w') as archive:
        for name in sorted(entries):
            info = zipfile.ZipInfo(name, STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, entries[name])
    report['zip'] = {'path': str(target.resolve()), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
                     'entries': {name: hashlib.sha256(data).hexdigest() for name, data in sorted(entries.items())}}
    report['passed'] = True
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('installer', type=Path)
    parser.add_argument('--app', type=Path, required=True, help='the app executable the installer was built from')
    parser.add_argument('--licenses', type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--out', type=Path, required=True, help='folder for the ZIP')
    parser.add_argument('--config', type=Path, action='append', default=[],
                        help='a Tauri config merged over desktop/tauri.conf.json, as the build used it')
    args = parser.parse_args()
    result = build(args.installer, args.app, args.licenses, args.version, args.out, args.config)
    print(json.dumps(result, indent=1))
    sys.exit(0 if result['passed'] else 1)
