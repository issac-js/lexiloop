"""Offline checks only: no authentication, database writes, or model calls."""
import ast
import functools
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
from urllib.parse import urlsplit
from urllib.request import urlopen

from release_bundle import ROOT, APP, PUBLIC_FILES


def run(*args):
    subprocess.run(args, cwd=ROOT, check=True)


def main():
    js_files = sorted([*ROOT.glob('lexiloop/**/*.js'), *ROOT.glob('tools/**/*.js'),
                       *ROOT.glob('tools/**/*.mjs')])
    with tempfile.TemporaryDirectory() as tmp:
        for f in js_files:
            target = Path(tmp) / 'check.mjs'
            target.write_bytes(f.read_bytes())
            run('node', '--check', str(target))
    py_files = sorted([*ROOT.glob('lexiloop/**/*.py'), *ROOT.glob('tools/**/*.py')])
    for f in py_files:
        ast.parse(f.read_text(encoding='utf-8'), filename=str(f))
    print('Syntax:', len(js_files), 'JavaScript;', len(py_files), 'Python')
    html = (APP / 'index.html').read_text(encoding='utf-8')
    version = re.search(r'js/app\.js\?v=(\d+)', html).group(1)
    for f in sorted((APP / 'js').glob('*.js')):
        text = f.read_text(encoding='utf-8')
        for relative in re.findall(r'''^import\s+[\s\S]*?['"](\./[^'"]+)['"]''', text, re.MULTILINE):
            parsed = urlsplit(relative)
            assert (f.parent / parsed.path).is_file(), (f.name, relative)
            assert parsed.query == 'v=' + version, (f.name, relative)
    for name in ['js/app.js', 'styles.css', 'manifest.webmanifest']:
        assert name + '?v=' + version in html, name
    sw = (APP / 'sw.js').read_text(encoding='utf-8')
    assert 'lexiloop-shell-v' + version + "'" in sw
    assert "'./styles.css?v=" + version + "'" in sw
    json.loads((APP / 'manifest.webmanifest').read_text())
    run('node', 'tools/qa-fsrs.js')
    run('node', '--test', 'tools/goal-metrics.test.js')
    run('node', '--test', 'tools/live-checks.test.js')
    run('node', '--test', 'tools/learning-schedule.test.js')
    run('node', '--test', 'tools/focus-practice.test.js')
    run('node', '--test', 'tools/content-review.test.js')
    # Import without writing __pycache__ into the served directory.
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('static_server', APP / 'server.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    handler = functools.partial(module.Handler, directory=str(APP))
    with module.Server(('127.0.0.1', 0), handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for name in PUBLIC_FILES:
                with urlopen('http://127.0.0.1:%d/%s' % (server.server_address[1], name), timeout=10) as response:
                    assert response.status == 200, name
                    assert response.read() == (APP / name).read_bytes(), name
                    if name.endswith('.js'):
                        assert 'javascript' in response.headers.get('Content-Type', ''), name
        finally:
            server.shutdown()
            thread.join()
    print('PASS: imports, versions, manifest, FSRS, %d public resources' % len(PUBLIC_FILES))


if __name__ == '__main__':
    main()
