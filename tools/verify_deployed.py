"""Read-only verification of a deployed bundle against an expected commit."""
import argparse
import hashlib
import json
import re
import time
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from release_bundle import PUBLIC_FILES


def fetch(base, name):
    url = base.rstrip('/') + '/' + name + '?verify=' + str(time.time_ns())
    request = Request(url, headers={'Cache-Control': 'no-cache'})
    with urlopen(request, timeout=30) as response:
        if urlsplit(response.url).netloc != urlsplit(base).netloc:
            raise ValueError('Unexpected cross-host redirect')
        return response.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--sha', required=True)
    args = parser.parse_args()
    url = urlsplit(args.url)
    if url.scheme != 'https' or not url.netloc or url.query or url.fragment or url.username or url.password:
        parser.error('--url must be a clean HTTPS site base URL')
    if not re.fullmatch(r'[0-9a-f]{40}', args.sha):
        parser.error('--sha must be the full source commit SHA')
    info = json.loads(fetch(args.url, 'release.json'))
    if info.get('source_sha') != args.sha:
        raise ValueError('Deployed source SHA does not match the expected commit')
    if set(info.get('files', {})) != set(PUBLIC_FILES):
        raise ValueError('Release manifest does not contain the exact public asset set')
    for name in PUBLIC_FILES:
        if hashlib.sha256(fetch(args.url, name)).hexdigest() != info['files'][name]:
            raise ValueError('Deployed asset checksum mismatch: ' + name)
    print('PASS: source SHA and all %d public assets match. Cloud login/data/AI remain separate checks.' % len(PUBLIC_FILES))


if __name__ == '__main__':
    main()
