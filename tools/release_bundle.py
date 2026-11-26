"""Build a public-assets-only release; never upload the repository root."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'lexiloop'
PUBLIC_FILES = (
    'index.html', 'styles.css', 'sw.js', 'manifest.webmanifest', 'icon.svg',
    'icon-180.png', 'icon-192.png', 'icon-512.png',
    'vendor/workbuddy-cloud-sdk.js',
    'js/app.js', 'js/cloud.js', 'js/config.js', 'js/enrich.js', 'js/exporter.js',
    'js/fsrs.js', 'js/game.js', 'js/focus.js', 'js/focus-core.js', 'js/transfer.js', 'js/goal-metrics.js', 'js/importer.js', 'js/judge.js', 'js/labs.js',
    'js/topic-content.js', 'js/topics.js',
    'js/store.js', 'js/ui.js', 'js/views.js', 'js/content-review.js', 'js/content-quality.js',
)


def manifest(sha):
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('A full 40-character source commit SHA is required')
    version = re.search(r'js/app\.js\?v=(\d+)', (APP / 'index.html').read_text()).group(1)
    files = {}
    for name in PUBLIC_FILES:
        path = APP / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('Missing or symlinked public asset: ' + name)
        files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return {'source_sha': sha, 'app_version': int(version), 'files': files}


def build(sha):
    info = manifest(sha)
    output = ROOT / 'dist'
    output.mkdir(exist_ok=True)
    target = output / ('lexiloop-' + sha + '.zip')
    # Stable timestamps and order make the same source reproducible.
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / 'release.zip'
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
            for name in PUBLIC_FILES:
                entry = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(entry, (APP / name).read_bytes())
            entry = zipfile.ZipInfo('release.json', (2020, 1, 1, 0, 0, 0))
            z.writestr(entry, json.dumps(info, ensure_ascii=False, indent=2) + '\n')
        target.write_bytes(archive.read_bytes())
    checksum = hashlib.sha256(target.read_bytes()).hexdigest()
    target.with_suffix('.zip.sha256').write_text(checksum + '  ' + target.name + '\n')
    print(target)
    return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sha', required=True)
    build(parser.parse_args().sha)
