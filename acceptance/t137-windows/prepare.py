#!/usr/bin/env python3
"""Prepare an isolated Windows guest run of guest-accept.ps1 (T-137): the
Yuzuno desktop's install, upgrade to a newer real package, and uninstall.

It only writes params.json and t137.wsb into a new or empty run config folder,
which the guest sees read-only (so nothing in the guest can change the
configuration a later run starts from); it starts nothing. Every path is given
explicitly; nothing is chosen from the current user, host or account.

The one thing it reads from this machine is its identity (guest-lib.ps1:
MachineGuid, SMBIOS UUID, computer name), recorded in params.json only as
digests salted with the run's token. guest-accept.ps1 refuses to run on a
machine whose identity matches it, or whose identity is missing. Run prepare.py
on the host that will start the guest. A guest other than Windows Sandbox is
admitted only if it is registered here with --guest-machine-guid and
--guest-smbios-uuid (read inside that guest beforehand).

  python3 prepare.py --lab-root C:\\yuzuno-lab\\t137 \\
      --installers C:\\yuzuno-lab\\t137\\in --harness C:\\yuzuno-lab\\t137\\harness \\
      --config C:\\yuzuno-lab\\t137\\run-1 --results C:\\yuzuno-lab\\t137\\out-1 \\
      --old yuzuno-desktop-0.2.0-setup.exe --old-sha256 <hex> --old-version 0.2.0 \\
      --new yuzuno-desktop-0.3.0-setup.exe --new-sha256 <hex> --new-version 0.3.0

Paths are Windows paths; when this runs in WSL, --host-path-prefix maps them
for reading (for example C:\\=/mnt/c/). Refused: a lab root that is a drive
root, a user profile folder or a parent of one; a mapped folder outside the lab
root, or one holding .ssh/.gnupg/.aws; a config or results folder that is not empty; an
installers folder holding anything but the two packages (and their .sig); a
package whose SHA-256 differs; the same version for old and new.

The .wsb turns off networking, the virtual GPU, the clipboard, audio and video
input and printers, caps memory, maps the installers, the harness and the run
config read-only and only the (empty) results folder writable, and runs nothing at logon: the person
starts guest-accept.ps1 inside the guest (see README). Windows Sandbox's own
resources are not governed by Yuzuno Core's Job budget.
"""
import argparse
import hashlib
import json
import re
import secrets
import shutil
import subprocess
import sys
from pathlib import Path, PureWindowsPath
from xml.sax.saxutils import escape

GUEST_ROOT = PureWindowsPath(r'C:\t137')
HARNESS_FILES = ('guest-accept.ps1', 'guest-lib.ps1')
LIB = Path(__file__).with_name('guest-lib.ps1')
IDENTITY = ('machineGuid', 'smbiosUuid', 'computerName')
# As Windows shows them, so the guest's own value matches: 8-4-4-4-12, no braces.
GUID = re.compile(r'[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}')
DIGEST = re.compile(r'[0-9a-f]{64}')
SECRET_DIRS = ('.ssh', '.gnupg', '.aws')
MAX_MEMORY_MIB = 8192


class Refused(Exception):
    pass


def win(value):
    path = PureWindowsPath(value)
    if not path.is_absolute() or not path.drive:
        raise Refused(f'{value}: give an absolute Windows path with a drive')
    # PureWindowsPath keeps ".." as written, and Windows would resolve it
    # outside the folder the checks below compare: refuse it.
    if any(part in ('.', '..') for part in value.replace('/', '\\').split('\\')):
        raise Refused(f'{value}: give the path without "." or ".." parts')
    return path


def inside(child, parent):
    c, p = [s.lower() for s in child.parts], [s.lower() for s in parent.parts]
    return c[:len(p)] == p


def host(path, prefix):
    """The local path that reads a Windows path (WSL: C:\\ -> /mnt/c/)."""
    if not prefix:
        return Path(str(path))
    drive, mount = prefix.split('=', 1)
    if path.drive.lower() + '\\' != drive.lower():
        raise Refused(f'{path}: not on {drive}')
    return Path(mount) / Path(*path.parts[1:])


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def check_lab_root(root):
    parts = [p.lower() for p in root.parts]
    if len(parts) < 2:
        raise Refused(f'{root}: a drive root cannot be the lab root')
    if parts[1] == 'users' and len(parts) <= 3:
        raise Refused(f'{root}: a user profile folder (or the folder above them) cannot be the lab root')


def plan(a):
    lab = win(a.lab_root)
    folders = {'installers': win(a.installers), 'harness': win(a.harness), 'config': win(a.config),
               'results': win(a.results)}
    check_lab_root(lab)
    for name, folder in folders.items():
        if not inside(folder, lab) or folder == lab:
            raise Refused(f'--{name} {folder}: must be a folder inside the lab root {lab}')
    every = list(folders.values())
    if len({str(p).lower() for p in every}) != len(every) or any(
            inside(x, y) for x in every for y in every if x != y):
        raise Refused('the installers, harness, config and results folders must be separate, not nested')
    if a.old_version == a.new_version:
        raise Refused('old and new are the same version: a reinstall is not an upgrade')
    if not 512 <= a.memory_mib <= MAX_MEMORY_MIB:
        raise Refused(f'--memory-mib must be 512..{MAX_MEMORY_MIB}')
    for name in (a.old, a.new):
        if not re.fullmatch(r'[A-Za-z0-9._-]+\.exe', name):
            raise Refused(f'{name}: give the package file name only')
    # What is mapped: checked on the host before anything is written.
    local = {k: host(v, a.host_path_prefix) for k, v in folders.items()}
    for name, folder in local.items():
        if folder.exists():
            secret = [p.name for p in folder.rglob('*') if p.name.lower() in SECRET_DIRS]
            if secret:
                raise Refused(f'--{name} {folder}: holds {secret}; never map such folders')
    allowed = {a.old, a.new, a.old + '.sig', a.new + '.sig'}
    present = {p.name for p in local['installers'].iterdir()} if local['installers'].is_dir() else set()
    if present - allowed:
        raise Refused(f'--installers holds other files too: {sorted(present - allowed)}')
    for name, expect in ((a.old, a.old_sha256), (a.new, a.new_sha256)):
        file = local['installers'] / name
        if not file.is_file():
            raise Refused(f'{file}: missing')
        if sha256(file) != expect.lower():
            raise Refused(f'{file}: SHA-256 is not {expect}')
    for name in ('config', 'results'):
        if local[name].exists() and any(local[name].iterdir()):
            raise Refused(f'--{name} {folders[name]}: must be new or empty')
    for file in HARNESS_FILES:
        if not (local['harness'] / file).is_file():
            raise Refused(f"--harness {folders['harness']}: holds no {file}")
    if (a.guest_machine_guid is None) != (a.guest_smbios_uuid is None):
        raise Refused('register a guest with both --guest-machine-guid and --guest-smbios-uuid, or neither')
    for value in (a.guest_machine_guid, a.guest_smbios_uuid):
        if value is not None and not GUID.fullmatch(value):
            raise Refused(f'{value}: give the GUID as Windows shows it (8-4-4-4-12, no braces)')
    return folders, local


def powershell(script):
    """Windows PowerShell given commands on stdin: no script file, no policy change."""
    exe = shutil.which('powershell.exe') or shutil.which('powershell')
    if not exe:
        raise Refused('no Windows PowerShell here to read the host identity with')
    run = subprocess.run([exe, '-NoProfile', '-NonInteractive', '-Command', '-'], input=script,
                         capture_output=True, text=True, timeout=120)
    try:
        return json.loads(run.stdout)
    except ValueError:
        raise Refused(f'PowerShell gave no identity: {run.stderr.strip()[:300]}') from None


def identity(token, guest=None, facts=None):
    """Salted digests (guest-lib.ps1) of this machine's identity, or of the given
    facts, which only tests pass; and of a registered guest's two GUIDs."""
    def literal(value):
        return "('" + json.dumps(value).replace("'", "''") + "' | ConvertFrom-Json)"
    machine = 'Get-GuestFacts' if facts is None else literal(facts)
    script = (LIB.read_text() + f"\n$token = '{token}'\n"
              f"$result = [ordered]@{{ host = Get-IdentityDigests {machine} $token }}\n")
    if guest:
        script += f"$result.guest = Get-IdentityDigests {literal(guest)} $token\n"
    return powershell(script + '$result | ConvertTo-Json -Compress\n')


def identities(a, token):
    guest = None
    if a.guest_machine_guid:
        guest = {'machineGuid': a.guest_machine_guid, 'smbiosUuid': a.guest_smbios_uuid}
    found = identity(token, guest)
    host = {name: (found.get('host') or {}).get(name) for name in IDENTITY}
    for name, digest in host.items():
        if not DIGEST.fullmatch(str(digest)):
            raise Refused(f"this host's {name} could not be read: without it a guest cannot tell itself from the host")
    if not guest:
        return host, None
    registered = {name: (found.get('guest') or {}).get(name) for name in ('machineGuid', 'smbiosUuid')}
    for name, digest in registered.items():
        if not DIGEST.fullmatch(str(digest)):
            raise Refused(f'the registered guest {name} is not usable')
        if digest == host[name]:
            raise Refused(f'the registered guest has this host\'s {name}: it is the host or a copy of it')
    return host, registered


def wsb(folders, memory):
    def mapped(folder, guest, read_only):
        return ('    <MappedFolder>\n'
                f'      <HostFolder>{escape(str(folder))}</HostFolder>\n'
                f'      <SandboxFolder>{escape(str(guest))}</SandboxFolder>\n'
                f'      <ReadOnly>{"true" if read_only else "false"}</ReadOnly>\n'
                '    </MappedFolder>\n')
    return ('<!-- T-137 Yuzuno desktop install/upgrade/uninstall guest (acceptance/t137-windows).\n'
            '     Nothing runs at logon; start guest-accept.ps1 by hand (README).\n'
            "     Yuzuno Core's Job budget does not govern this guest's CPU or memory. -->\n"
            '<Configuration>\n'
            '  <VGpu>Disable</VGpu>\n'
            '  <Networking>Disable</Networking>\n'
            '  <AudioInput>Disable</AudioInput>\n'
            '  <VideoInput>Disable</VideoInput>\n'
            '  <ClipboardRedirection>Disable</ClipboardRedirection>\n'
            '  <PrinterRedirection>Disable</PrinterRedirection>\n'
            '  <ProtectedClient>Enable</ProtectedClient>\n'
            f'  <MemoryInMB>{memory}</MemoryInMB>\n'
            '  <MappedFolders>\n'
            + mapped(folders['installers'], GUEST_ROOT / 'in', True)
            + mapped(folders['harness'], GUEST_ROOT / 'harness', True)
            + mapped(folders['config'], GUEST_ROOT / 'config', True)
            + mapped(folders['results'], GUEST_ROOT / 'out', False)
            + '  </MappedFolders>\n'
            '</Configuration>\n')


def prepare(a):
    folders, local = plan(a)
    token = secrets.token_hex(16)
    host, guest = identities(a, token)
    params = {'token': token, 'hostIdentity': host, 'guestIdentity': guest,
              'old': {'path': str(GUEST_ROOT / 'in' / a.old), 'sha256': a.old_sha256.lower(), 'version': a.old_version},
              'new': {'path': str(GUEST_ROOT / 'in' / a.new), 'sha256': a.new_sha256.lower(), 'version': a.new_version},
              'product': 'Yuzuno', 'identifier': 'dev.yuzuno.workspace',
              'testCoreUrl': 'http://127.0.0.1:5317/', 'results': str(GUEST_ROOT / 'out')}
    for name in ('config', 'results'):
        local[name].mkdir(parents=True, exist_ok=True)
    (local['config'] / 'params.json').write_text(json.dumps(params, indent=1) + '\n')
    (local['config'] / 't137.wsb').write_text(wsb(folders, a.memory_mib))
    return {'params': str(local['config'] / 'params.json'), 'wsb': str(local['config'] / 't137.wsb'),
            'token': token}


def parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for name in ('lab-root', 'installers', 'harness', 'config', 'results', 'old', 'old-sha256', 'old-version',
                 'new', 'new-sha256', 'new-version'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--memory-mib', type=int, default=4096)
    p.add_argument('--guest-machine-guid', help='a guest other than Windows Sandbox: its MachineGuid')
    p.add_argument('--guest-smbios-uuid', help='and its SMBIOS UUID (Win32_ComputerSystemProduct)')
    p.add_argument('--host-path-prefix', help=r'map Windows paths for reading here, e.g. C:\=/mnt/c/')
    return p


if __name__ == '__main__':
    try:
        print(json.dumps(prepare(parser().parse_args()), indent=1))
    except Refused as error:
        print(f'refused: {error}', file=sys.stderr)
        sys.exit(2)
