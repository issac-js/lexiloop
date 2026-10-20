"""Reject CRLF/mixed text in the Git index or working tree; do not rewrite files."""
import argparse
from pathlib import Path
import subprocess
import sys


def check(root):
    root = Path(root).resolve()
    top = subprocess.run(['git', '-C', str(root), 'rev-parse', '--show-toplevel'],
                         check=True, capture_output=True, text=True).stdout.strip()
    if Path(top).resolve() != root:
        raise ValueError('Run against the repository root, not a subdirectory')
    output = subprocess.run(['git', '-C', str(root), 'ls-files', '--eol', '-z'],
                            check=True, capture_output=True).stdout
    problems = []
    count = 0
    for entry in output.split(b'\0'):
        if not entry:
            continue
        metadata, name = entry.split(b'\t', 1)
        fields = metadata.split()
        count += 1
        if any(value in fields for value in
               [b'i/crlf', b'i/mixed', b'w/crlf', b'w/mixed']):
            problems.append(name.decode('utf-8', errors='replace'))
    for name in problems:
        print('FAIL: CRLF/mixed text:', name)
    if problems:
        return 1
    print('PASS: LF line endings for %d tracked entries (binary files preserved)' % count)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        return check(args.root)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print('Line-ending check could not run:', error, file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
