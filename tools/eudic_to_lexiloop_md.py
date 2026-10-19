# -*- coding: utf-8 -*-
"""
eudic_to_lexiloop_md.py — 欧路词典生词本 CSV → LexiLoop 结构化 Markdown（带释义与例句）

为什么用 Markdown 而不是两列 CSV：
  LexiLoop 的 CSV 导入只吃「单词,释义」两列，欧路导出里的例句会被整段塞进释义；
  结构化 Markdown（## 单词 / **释义** / > 例句 / > 译文）能同时带入释义与例句，
  导入后例句会进卡片的 source_examples，学习页与词条页都能看到。

欧路导出列：单词, 星标, 音标, 释义, 笔记
  其中「释义」有两种形态：
    ① 词典释义：  vt. 诱拐；绑架；[生]使外展
    ② 例句串：    - English sentence. 中文译文。 - English… 中文…（用 " - " 分隔）

用法：
  python eudic_to_lexiloop_md.py 所有生词本.csv                 # 生成 同名.lexiloop.md
  python eudic_to_lexiloop_md.py 所有生词本.csv -o out.md --max-examples 2 --title 欧路生词本
"""
import argparse
import csv
import re
import sys
from pathlib import Path

CJK = re.compile(r'[\u4e00-\u9fff]')
SEG_SPLIT = re.compile(r'\s+-\s+')
TRUNC_TAIL = re.compile(r'[.!?"”’]$')
WORD_HDR = re.compile(r'^(单词|单字|word|term|name)$', re.I)
MEAN_HDR = re.compile(r'^(释义|翻译|解释|中文|意思|trans|meaning)$', re.I)
# 欧路有些行的「释义」实际是词性分布标签（如「全部名词动词」），不是释义
POS_LABEL = re.compile(r'^全部[名词动词形副介连代数量冠感叹拟声助词]+$')
ONLY_POS = re.compile(r'^(n|v|vt|vi|adj|adv|prep|pron|conj|num|art|int|interj|aux)\.?$', re.I)


def is_junk_definition(d):
    """不是真释义的「释义」：词性标签、只有词性、纯符号"""
    s = str(d or '').strip()
    if not s:
        return True
    if POS_LABEL.match(s) or ONLY_POS.match(s):
        return True
    if not re.search(r'[\u4e00-\u9fff a-z]', s, re.I):
        return True
    return False


def clean_en(s):
    s = re.sub(r'\s+', ' ', str(s or '')).strip()
    s = re.sub(r'\s+([,.;:!?])', r'\1', s)      # 欧路会在标点前插空格
    # 双连字符在 Markdown 结构化导入里会被当成「术语 --- 释义」的分隔符，统一成破折号
    return re.sub(r'-{2,}', '—', s)


def clean_zh(s):
    s = re.sub(r'\s+', ' ', str(s or '')).strip()
    # 中文之间的空格是欧路换行造成的，去掉；中英之间保留
    return re.sub(r'(?<=[\u4e00-\u9fff，。；：、！？（）“”])\s+(?=[\u4e00-\u9fff，。；：、！？（）“”])', '', s)


def parse_cell(cell, max_examples):
    """把欧路的「释义」单元格拆成 (词典释义, 例句列表)"""
    raw = re.sub(r'\s+', ' ', str(cell or '')).strip()
    if not raw:
        return '', []
    starts_with_ex = bool(re.match(r'^-\s', raw))
    parts = [p.strip() for p in SEG_SPLIT.split(raw) if p.strip()]
    definition = ''
    segments = []
    for i, p in enumerate(parts):
        if i == 0 and not starts_with_ex:
            definition = p.lstrip('- ').strip()
        else:
            segments.append(p.lstrip('- ').strip())

    examples = []
    for k, seg in enumerate(segments):
        m = CJK.search(seg)
        en = clean_en(seg[:m.start()]) if m else clean_en(seg)
        zh = clean_zh(seg[m.start():]) if m else ''
        if not en:
            continue
        # 末段没有句末标点通常是导出被截断，丢掉
        if k == len(segments) - 1 and len(segments) > 1 and not TRUNC_TAIL.search(en):
            continue
        examples.append({'en': en, 'zh': zh})
    if is_junk_definition(definition):
        definition = ''
    return definition, examples[:max_examples]


def read_rows(path):
    raw = path.read_bytes()
    for enc in ('utf-8-sig', 'utf-8', 'gb18030', 'big5'):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise SystemExit('无法识别文件编码')
    if '\t' in text.splitlines()[0] and ',' not in text.splitlines()[0]:
        return list(csv.reader(text.splitlines(), delimiter='\t')), enc
    return list(csv.reader(text.splitlines())), enc


def main():
    ap = argparse.ArgumentParser(description='欧路生词本 CSV → LexiLoop 结构化 Markdown')
    ap.add_argument('src')
    ap.add_argument('-o', '--out')
    ap.add_argument('--max-examples', type=int, default=3, help='每个词最多带几条例句（默认 3）')
    ap.add_argument('--title', default='', help='章节标题；默认用时间戳')
    ap.add_argument('--csv-too', action='store_true', help='同时输出两列 CSV（只含单词与词典释义）')
    args = ap.parse_args()

    src = Path(args.src)
    if not src.exists():
        raise SystemExit('找不到文件：' + str(src))

    rows, enc = read_rows(src)
    if not rows:
        raise SystemExit('文件是空的')
    header = [c.strip() for c in rows[0]]
    wcol = next((i for i, c in enumerate(header) if WORD_HDR.match(c)), 0)
    mcol = next((i for i, c in enumerate(header) if MEAN_HDR.match(c)), 3)
    body = rows[1:]

    seen = set()
    items = []
    for r in body:
        if len(r) <= max(wcol, mcol):
            continue
        word = re.sub(r'\s+', ' ', r[wcol]).strip().lower()
        if not word or not re.search(r'[a-z]', word) or len(word.split(' ')) > 6:
            continue
        if word in seen:
            continue
        seen.add(word)
        definition, examples = parse_cell(r[mcol], args.max_examples)
        items.append({'word': word, 'def': definition, 'examples': examples})

    title = args.title or ('欧路生词本（' + src.stem.replace('所有生词本_', '') + '）')
    L = ['# ' + title, '']
    for x in items:
        L.append('## ' + x['word'])
        if x['def']:
            L.append('**' + x['def'] + '**')
        for e in x['examples']:
            L.append('> ' + e['en'])
            if e['zh']:
                L.append('> ' + e['zh'])
        L.append('')

    out = Path(args.out) if args.out else src.with_name(src.stem + '.lexiloop.md')
    out.write_text('\n'.join(L), encoding='utf-8')

    n_ex = sum(len(x['examples']) for x in items)
    print('源编码：%s　｜　读入 %d 行 → 输出 %d 个词条' % (enc, len(body), len(items)))
    print('含词典释义 %d 个　｜　含例句 %d 个（共 %d 条例句）' % (
        sum(1 for x in items if x['def']), sum(1 for x in items if x['examples']), n_ex))
    print('已写出：%s' % out)
    print('导入：LexiLoop → 词库 → 导入词条 → 选文件（md）→ 不勾选 AI 生成 → 开始导入')

    if args.csv_too:
        import csv as _csv
        cs = src.with_name(src.stem + '.lexiloop.csv')
        with cs.open('w', encoding='utf-8-sig', newline='') as f:
            wr = _csv.writer(f)
            wr.writerow(['word', '释义'])
            for x in items:
                if x['def']:
                    wr.writerow([x['word'], x['def']])
        print('（另存两列 CSV，仅含 %d 个有词典释义的词：%s）' % (
            sum(1 for x in items if x['def']), cs))
    return 0


if __name__ == '__main__':
    sys.exit(main())
