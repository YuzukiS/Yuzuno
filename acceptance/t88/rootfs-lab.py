#!/usr/bin/env python3
"""Run the package lab in a prepared, disposable Linux rootfs using bubblewrap."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time

PACKAGE_FILES = ('yuzuno-core-linux-x86_64.json', 'yuzuno-core-linux-x86_64.json.minisig',
                 'yuzuno-core-linux-x86_64.tar.gz')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rootfs', type=Path, required=True, help='Prepared disposable rootfs, never / or a host installation')
    parser.add_argument('--package-dir', type=Path, required=True, help='Only the three regular release files')
    parser.add_argument('--lab', type=Path, required=True, help='New output directory outside the rootfs')
    parser.add_argument('--tag', required=True)
    parser.add_argument('--public-key', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--bwrap', default='bwrap')
    parser.add_argument('--python', default='/usr/bin/python3', help='Absolute interpreter path inside the rootfs')
    parser.add_argument('--minisign', default='/usr/local/bin/minisign', help='Absolute verifier path inside the rootfs')
    args = parser.parse_args()
    root, package, lab = args.rootfs.resolve(strict=True), args.package_dir.resolve(strict=True), args.lab.resolve()
    source = Path(__file__).resolve().parent
    if root == Path('/') or source.is_relative_to(root) or lab.is_relative_to(root) or package.is_relative_to(root):
        parser.error('rootfs must be separate from source, package and lab')
    if lab.is_relative_to(package) or package.is_relative_to(lab):
        parser.error('package and lab must not overlap')
    if args.lab.exists() or args.lab.is_symlink():
        parser.error('--lab must be a new directory')
    if not 1 <= args.port <= 65535:
        parser.error('--port must be between 1 and 65535')
    if not all(Path(p).is_absolute() for p in (args.python, args.minisign)):
        parser.error('rootfs tool paths must be absolute')
    if set(p.name for p in package.iterdir()) != set(PACKAGE_FILES) or any(
            not (package/name).is_file() or (package/name).is_symlink() for name in PACKAGE_FILES):
        parser.error('package directory must contain exactly the three regular release files')
    for name in ('lab', 'package'):
        mount = root/name
        if mount.is_symlink() or not mount.is_dir() or any(mount.iterdir()):
            parser.error(f'prepare an empty /{name} directory inside the rootfs')
    # Cheap native preflight before copying inputs or starting any product.
    subprocess.run([args.bwrap, '--unshare-all', '--ro-bind', str(root), '/', '--proc', '/proc',
                    '--dev', '/dev', '--clearenv', '--', '/bin/true'], check=True, timeout=10)
    lab.mkdir(parents=True, mode=0o700)
    harness = lab/'harness'
    harness.mkdir()
    for name in ('install-lab.py', 'package_lab.py'):
        shutil.copyfile(source/name, harness/name)
    command = [args.bwrap, '--unshare-all', '--uid', '0', '--gid', '0', '--new-session', '--die-with-parent',
               '--ro-bind', str(root), '/', '--ro-bind', str(package), '/package', '--bind', str(lab), '/lab',
               '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--chdir', '/lab', '--clearenv',
               '--setenv', 'PATH', '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', '--setenv', 'LANG', 'C.UTF-8',
               '--', args.python, '/lab/harness/install-lab.py', 'package', '--package-dir', '/package',
               '--lab', '/lab/run', '--port', str(args.port), '--tag', args.tag,
               '--public-key', args.public_key, '--minisign', args.minisign]
    receipt = {'startedAt': time.time(), 'command': command,
               'inputs': {name: hashlib.sha256((harness/name).read_bytes()).hexdigest() for name in ('install-lab.py', 'package_lab.py')},
               'isolation': 'read-only prepared rootfs and package; writable lab and private tmp/dev/proc; separate user, PID, mount, IPC, UTS and network namespaces; inherited environment cleared, explicit PATH/LANG (bubblewrap adds PWD)',
               'limitations': 'Mapped root is not a new OS account. Same host kernel. No systemd, real login or browser rendering.'}
    try:
        result = subprocess.run(command, timeout=300)
        receipt['exitCode'] = result.returncode
    except Exception as error:
        receipt.update(exitCode=1, error=repr(error))
    finally:
        receipt['finishedAt'] = time.time()
        (lab/'isolation.json').write_text(json.dumps(receipt, indent=2)+'\n')
    return receipt['exitCode']


if __name__ == '__main__':
    raise SystemExit(main())
