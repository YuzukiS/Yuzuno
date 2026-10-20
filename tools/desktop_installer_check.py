#!/usr/bin/env python3
"""Check that a built Windows installer carries the desktop app's notices (T-90).

  python3 tools/desktop_installer_check.py <...-setup.exe> --licenses desktop/licenses

Reads the NSIS installer that scripts/desktop.ps1 -Bundle made. The Tauri CLI
compresses it as one solid LZMA stream. The check:
1. finds NSIS's first header (at a 512-byte boundary);
2. checks its CRC32, which covers everything from byte 512 on;
3. decompresses the stream, whose first block is the install script, and splits
   the rest into the stored files' data blocks, which must end exactly where
   the stream does.

It passes only if every file of the licenses folder that ships (LICENSE,
THIRD_PARTY_NOTICES-desktop.txt, rust-std-COPYRIGHT-library.html) is, byte for
byte, one of those blocks. Any other layout is refused, never passed.
Prints a JSON report; exits 1 unless it passed.
"""
import argparse
import hashlib
import json
import lzma
from pathlib import Path
import struct
import zlib

SIGNATURE = b'\xef\xbe\xad\xdeNullsoftInst'
SHIPPED = ('LICENSE', 'THIRD_PARTY_NOTICES-desktop.txt', 'rust-std-COPYRIGHT-library.html')
CRC_START = 512


def blocks(data):
    """The data blocks NSIS stores after the install script, in order."""
    start = next((o for o in range(0, len(data) - 28, 512) if data[o + 4:o + 20] == SIGNATURE), None)
    if start is None:
        raise ValueError('not an NSIS installer: no first header at a 512-byte boundary')
    flags, _, _, _, _, header, length = struct.unpack('<7I', data[start:start + 28])
    end = start + length
    if end > len(data) or length < 32:
        raise ValueError('the first header names more data than the file holds')
    stored, = struct.unpack('<I', data[end - 4:end])
    if zlib.crc32(data[CRC_START:end - 4]) & 0xffffffff != stored:
        raise ValueError('the installer CRC does not match its data')
    stream = data[start + 28:end - 4]
    if stream[:1] != b'\x5d':
        raise ValueError('not one solid LZMA stream (the layout the Tauri CLI writes)')
    decoder = lzma.LZMADecompressor(format=lzma.FORMAT_ALONE)
    # NSIS writes LZMA properties without the size field; give it "unknown".
    try:
        out = decoder.decompress(stream[:5] + b'\xff' * 8 + stream[5:])
    except lzma.LZMAError as error:
        raise ValueError(f'the LZMA stream does not decode: {error}') from None
    if not decoder.eof:
        raise ValueError('the LZMA stream ends early')
    found, pos = [], 0
    while pos < len(out):
        if pos + 4 > len(out):
            raise ValueError('the stream ends inside a block length')
        size, = struct.unpack('<I', out[pos:pos + 4])
        if size & 0x80000000 or pos + 4 + size > len(out):
            raise ValueError('a block is compressed on its own or runs past the stream')
        found.append(out[pos + 4:pos + 4 + size])
        pos += 4 + size
    if not found or len(found[0]) != header:
        raise ValueError('the first block is not the install script the first header names')
    return found[1:], flags


def check(installer, licenses):
    data = Path(installer).read_bytes()
    report = {'installer': {'path': str(Path(installer).resolve()), 'sha256': hashlib.sha256(data).hexdigest()},
              'files': {}, 'passed': False}
    try:
        stored, flags = blocks(data)
        report.update(blocks=len(stored), flags=flags)
    except ValueError as error:
        report['refused'] = str(error)
        return report
    digests = {hashlib.sha256(block).hexdigest() for block in stored}
    for name in SHIPPED:
        file = Path(licenses) / name
        if not file.is_file():
            report['files'][name] = {'error': 'not in the licenses folder'}
            continue
        digest = hashlib.sha256(file.read_bytes()).hexdigest()
        report['files'][name] = {'sha256': digest, 'inInstaller': digest in digests}
    report['passed'] = all(f.get('inInstaller') for f in report['files'].values())
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('installer', type=Path)
    parser.add_argument('--licenses', type=Path, required=True)
    args = parser.parse_args()
    result = check(args.installer, args.licenses)
    print(json.dumps(result, indent=1))
    raise SystemExit(0 if result['passed'] else 1)
