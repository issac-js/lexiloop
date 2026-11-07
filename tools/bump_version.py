# -*- coding: utf-8 -*-
"""
bump_version.py — 一键升版（JS 模块 + 样式 + manifest + Service Worker）

为什么必须存在这个脚本：
  静态托管/CDN 会按 URL 缓存资源。带着 ?v=N 的 JS 每次升版都是新 URL，所以永远新鲜；
  而不带版本号的 styles.css / manifest 会被缓存旧版 —— 表现就是"我明明改了 CSS，
  线上却没变"。这个脚本把**所有**前端资源统一挂上同一个版本号，避免漏掉任何一个。

做的事：
  1. js/*.js 里所有 `./x.js?v=N` → v=新版本
  2. index.html：app.js、styles.css、manifest.webmanifest 的引号内版本
  3. sw.js：CACHE 名 + SHELL 预缓存清单里的版本
  4. 校验：全仓不应再出现过期版本号；打印逐项确认

用法：
  python tools/bump_version.py 83 --root lexiloop
  python tools/bump_version.py --check --root lexiloop        # 只检查一致性，不改
"""
import argparse
import pathlib
import re
import sys

TARGETS_HTML = ['js/app.js', 'styles.css', 'manifest.webmanifest']


def read(p):
    return p.read_text(encoding='utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('version', nargs='?', help='新版本号，例如 83')
    ap.add_argument('--root', default='lexiloop')
    ap.add_argument('--check', action='store_true', help='只校验一致性')
    args = ap.parse_args()

    root = pathlib.Path(args.root).resolve()
    idx = root / 'index.html'
    sw = root / 'sw.js'
    if not idx.exists() or not sw.exists():
        print('找不到 index.html / sw.js，--root 指到站点目录（默认 lexiloop）')
        return 2

    html = read(idx)
    m = re.search(r'js/app\.js\?v=(\d+)', html)
    cur = m.group(1) if m else '?'

    if args.check:
        print('index.html 里 app.js 版本: v%s' % cur)
        stale = []
        for f in sorted((root / 'js').glob('*.js')):
            for v in set(re.findall(r'\.js\?v=(\d+)', read(f))):
                if v != cur:
                    stale.append('%s → v%s' % (f.name, v))
        for t in TARGETS_HTML:
            mm = re.search(re.escape(t) + r'\?v=(\d+)', html)
            if not mm:
                print('  ⚠ %s 没有版本号（会被缓存旧版）' % t)
            elif mm.group(1) != cur:
                stale.append('%s → v%s' % (t, mm.group(1)))
        swt = read(sw)
        for v in set(re.findall(r'\?v=(\d+)', swt)):
            if v != cur:
                stale.append('sw.js SHELL → v%s' % v)
        cache_v = re.search(r"lexiloop-shell-v(\d+)", swt)
        if cache_v and cache_v.group(1) != cur:
            stale.append('sw.js CACHE → v%s' % cache_v.group(1))
        if stale:
            print('不一致：')
            for x in stale:
                print('  ✗', x)
            return 1
        print('全部一致 ✅')
        return 0

    if not args.version or not re.fullmatch(r'\d+', args.version):
        print('请给出数字版本号，例如：python tools/bump_version.py 83')
        return 2
    new = args.version
    changed = []

    # 1) JS 模块互引
    for f in sorted((root / 'js').glob('*.js')):
        t = read(f)
        t2, n = re.subn(r'(\./[A-Za-z0-9_\-]+\.js)\?v=\d+', lambda mm: mm.group(1) + '?v=' + new, t)
        if n:
            f.write_text(t2, encoding='utf-8')
            changed.append('%s (%d 处)' % (f.name, n))

    # 2) index.html：入口脚本 + 样式 + manifest
    html2 = re.subn(r'(src="js/app\.js)\?v=\d+', r'\1?v=' + new, html)[0]
    for asset in TARGETS_HTML[1:]:
        pat = re.compile(r'(href="' + re.escape(asset) + r')(\?v=\d+)?(")')
        html2, n = pat.subn(lambda mm: mm.group(1) + '?v=' + new + mm.group(3), html2)
        if n:
            changed.append('%s (%d 处)' % (asset, n))
        else:
            print('  ⚠ index.html 里没找到 %s 的引用' % asset)
    idx.write_text(html2, encoding='utf-8')

    # 3) sw.js：CACHE 名 + SHELL 里的样式
    swt = read(sw)
    swt2, n1 = re.subn(r"lexiloop-shell-v\d+", 'lexiloop-shell-v' + new, swt)
    swt2, n2 = re.subn(r"'\./styles\.css(\?v=\d+)?'", "'./styles.css?v=" + new + "'", swt2)
    swt2 = re.sub(r'(\./[A-Za-z0-9_./-]+)\?v=\d+', lambda m: m.group(1) + '?v=' + new, swt2)
    sw.write_text(swt2, encoding='utf-8')
    changed.append('sw.js CACHE(%d) + SHELL(%d)' % (n1, n2))

    # 4) 校验：不应再出现过期版本
    stale = []
    for f in sorted((root / 'js').glob('*.js')):
        for v in set(re.findall(r'\.js\?v=(\d+)', read(f))):
            if v != new:
                stale.append('%s → v%s' % (f.name, v))
    html3 = read(idx)
    for t in TARGETS_HTML:
        for v in set(re.findall(re.escape(t) + r'\?v=(\d+)', html3)):
            if v != new:
                stale.append('index.html %s → v%s' % (t, v))
    for v in set(re.findall(r"lexiloop-shell-v(\d+)", read(sw))):
        if v != new:
            stale.append('sw.js CACHE → v%s' % v)

    print('升版到 v%s：' % new)
    for c in changed:
        print('  ·', c)
    if stale:
        print('仍有未更新：')
        for x in stale:
            print('  ✗', x)
        return 1
    print('校验通过：所有资源版本一致 ✅（旧版 %s → 新版 %s）' % (cur, new))
    return 0


if __name__ == '__main__':
    sys.exit(main())
