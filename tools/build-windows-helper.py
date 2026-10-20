#!/usr/bin/env python3
"""Build the native Windows Jobs helper from a fixed source commit (T-108).

Windows' own .NET Framework compiler builds core/src/jobs/windows_job.cs as
it is in that commit, run through WSL interop: run this as a Yuzuno Job on a
WSL host with interop on. It writes the helper and windows-helper.json, the
record of what was built from what and how, into a new folder. Committed as
runtimes/windows-jobs they are a release input: tools/build-core-artifact.py
checks them against the tree and tools/package-release.py ships them.

That compiler is not deterministic (it stamps a time and a module ID into
the file), so a rebuild gives other bytes: the committed helper is the input,
and this record and the Job that ran it are where it came from.
"""
import argparse
import datetime
import hashlib
import os
from pathlib import Path
import platform
import re
import shutil
import struct
import subprocess
import sys
import tempfile
sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_common import command, digest, write

ROOT = Path(__file__).resolve().parents[1]
SOURCE = 'core/src/jobs/windows_job.cs'
NAME = 'yuzuno-jobs-helper.exe'
RECORD = 'windows-helper.json'
# .NET Framework 4's own C# 5 compiler, which every supported Windows has.
COMPILER = Path('/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe')
COMPILER_WINDOWS = r'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
FLAGS = ['/noconfig', '/target:exe', '/platform:x64', '/optimize',
         '/r:System.dll', '/r:System.Web.Extensions.dll', '/r:System.Management.dll']
REQUIRES = ('Windows x64 with .NET Framework 4 (v4.0.30319, part of Windows), '
            'started by a Core in WSL with Windows interop on')


def protocol(text):
    """The request/reply protocol the source declares (remote.rs WINDOWS_PROTOCOL)."""
    found = re.findall(r'^\s*const int Protocol = (\d+);', text, re.M)
    if len(found) != 1:
        raise ValueError(f'{SOURCE} must declare exactly one Protocol')
    return int(found[0])


def x64_program(path):
    """A Windows x64 executable (PE, machine AMD64), by its headers."""
    data = path.read_bytes()
    if data[:2] != b'MZ' or len(data) < 0x40:
        return False
    offset = struct.unpack_from('<I', data, 0x3C)[0]
    return data[offset:offset + 4] == b'PE\0\0' and struct.unpack_from('<H', data, offset + 4)[0] == 0x8664


def build(commit, out):
    out = out.resolve()
    if out.exists() or not out.is_relative_to(ROOT / 'target'):
        raise ValueError('Use a new output folder under this checkout\'s target/')
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Name the full source commit')
    if command(['git', 'rev-parse', '--verify', commit + '^{commit}'], cwd=ROOT) != commit:
        raise ValueError(f'{commit} is not a commit of this repository')
    if not COMPILER.is_file():
        raise ValueError(f'Windows\' .NET Framework 4 compiler is not at {COMPILER}; run this in WSL on Windows x64')
    source = subprocess.run(['git', 'show', f'{commit}:{SOURCE}'], cwd=ROOT, check=True, capture_output=True).stdout
    expected_protocol = protocol(source.decode('utf-8'))
    out.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.windows-helper-', dir=out.parent))
    try:
        (stage / 'windows_job.cs').write_bytes(source)
        windows = lambda path: command(['wslpath', '-w', path])
        arguments = FLAGS + ['/out:' + windows(stage / NAME), windows(stage / 'windows_job.cs')]
        # Without /nologo: the compiler names its own version first.
        compiled = subprocess.run([str(COMPILER), *arguments], cwd=stage, capture_output=True, timeout=600)
        output = (compiled.stdout + compiled.stderr).decode('utf-8', 'replace').replace('\r\n', '\n').strip()
        if compiled.returncode != 0 or re.search(r'\b(error|warning) CS\d+', output):
            raise ValueError(f'The compiler exited {compiled.returncode}:\n{output}')
        helper = stage / NAME
        if not x64_program(helper):
            raise ValueError('The compiler did not write a Windows x64 program')
        # WSL interop runs only files with the execute bit; the compiler writes 0644.
        helper.chmod(0o755)
        version = next((line.strip() for line in output.splitlines() if 'version' in line.lower()), None)
        if not version:
            raise ValueError(f'The compiler did not name its version:\n{output}')
        (stage / 'windows_job.cs').unlink()
        write(stage / RECORD, {
            'format': 1, 'file': NAME, 'sha256': digest(helper), 'bytes': helper.stat().st_size,
            'protocol': expected_protocol,
            'source': {'commit': commit, 'path': SOURCE, 'sha256': hashlib.sha256(source).hexdigest(),
                       'blob': command(['git', 'rev-parse', f'{commit}:{SOURCE}'], cwd=ROOT)},
            'compiler': {'path': COMPILER_WINDOWS, 'sha256': digest(COMPILER), 'version': version,
                         'output': output, 'flags': FLAGS},
            'requires': REQUIRES,
            'builtAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
            'builtOn': platform.platform(),
        })
        stage.rename(out)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    print(out / RECORD)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--commit', required=True, help='full source commit to build windows_job.cs from')
    parser.add_argument('--out', type=Path, required=True, help='new folder under target/')
    arguments = parser.parse_args()
    if 'WSL_INTEROP' not in os.environ and not Path('/proc/sys/fs/binfmt_misc/WSLInterop').exists():
        sys.exit('WSL interop is not available here')
    build(arguments.commit, arguments.out)
