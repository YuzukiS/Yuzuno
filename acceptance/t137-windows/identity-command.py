#!/usr/bin/env python3
r"""The Windows Job command for identity-check.ps1 (README, "On an ordinary account").

    python3 identity-command.py --out 'C:\t137-lab\out-1' \
      --old 'C:\t137-lab\in\Yuzuno T137_0.2.0_x64-setup.exe' --old-sha256 <hex> \
      --new 'C:\t137-lab\in\Yuzuno T137_0.2.1_x64-setup.exe' --new-sha256 <hex>

Prints JSON: the argv (Windows PowerShell with the text as its -Command: lines
setting the five inputs, then upgrade-steps.ps1 and identity-check.ps1 as they
are), the SHA-256 of both scripts and the argv's size. No script file runs and
the execution policy is not changed. It refuses a path that is not an absolute
Windows drive path or has a '.' or '..' part, a SHA-256 that is not 64 hex
digits, and a command over the 16 KiB a Windows Job's argv may hold.
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PARTS = ('upgrade-steps.ps1', 'identity-check.ps1')
LIMIT = 16 * 1024


class Refused(Exception):
    pass


def windows_path(value):
    if not re.fullmatch(r'[A-Za-z]:\\[^\r\n"]*', value) or any(part in ('.', '..') for part in value.split('\\')):
        raise Refused(f'not an absolute Windows path: {value!r}')
    return value


def sha256(value):
    if not re.fullmatch(r'[0-9a-fA-F]{64}', value):
        raise Refused(f'not a SHA-256: {value!r}')
    return value.lower()


def quote(value):
    return "'" + value.replace("'", "''") + "'"


def command(out, old, old_sha256, new, new_sha256):
    inputs = (('T137Out', windows_path(out)), ('T137Old', windows_path(old)), ('T137OldSha256', sha256(old_sha256)),
              ('T137New', windows_path(new)), ('T137NewSha256', sha256(new_sha256)))
    scripts = {name: (HERE / name).read_text(encoding='utf-8') for name in PARTS}
    text = ''.join(f'${name} = {quote(value)}\n' for name, value in inputs) + '\n'.join(scripts.values())
    argv = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', text]
    size = sum(len(arg.encode('utf-8')) for arg in argv)
    if size > LIMIT:
        raise Refused(f'the command is {size} bytes, over the {LIMIT} a Windows Job takes')
    return {'argv': argv, 'scripts': {name: hashlib.sha256(body.encode('utf-8')).hexdigest() for name, body in scripts.items()},
            'bytes': size}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for name in ('out', 'old', 'old-sha256', 'new', 'new-sha256'):
        parser.add_argument('--' + name, required=True)
    a = parser.parse_args()
    try:
        print(json.dumps(command(a.out, a.old, a.old_sha256, a.new, a.new_sha256), indent=2))
    except Refused as error:
        sys.exit(f'Refused: {error}')


if __name__ == '__main__':
    main()
