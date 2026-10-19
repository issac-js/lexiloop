# -*- coding: utf-8 -*-
"""
eudic_to_lexiloop.py — 把欧路词典导出的生词本转成 LexiLoop 可直接导入的两列 CSV

为什么需要它：LexiLoop 的导入器规定「csv/tsv 取第一列单词、第二列释义」，
而欧路导出的文件常见三种形态，直接导入会错位或丢释义：
  1. PC 客户端 CSV：单词, 音标, 释义, 星级, 分组 …（列多、顺序不定）
  2. 手机 App TXT：每行 "word  /ˈfəʊnɪm/  n. 释义"
  3. 网页版「打印当前列表」复制到 Excel：单词 | 翻译

本脚本统一输出：word,释义（UTF-8 with BOM，Windows Excel 直接双击不乱码）

用法：
  python eudic_to_lexiloop.py 生词本.csv                 # 生成 生词本.lexiloop.csv
  python eudic_to_lexiloop.py 生词本.txt -o out.csv
  python eudic_to_lexiloop.py 生词本.csv --max-words 5    # 超过 5 个词的短语丢弃
"""
import argparse
import csv
import re
import sys
from pathlib import Path

# 列名识别（中英文都认）
WORD_HDR = re.compile(r'^(单词|单字|word|term|name|head|拼写|expression)$', re.I)
MEAN_HDR = re.compile(r'^(释义|翻译|解释|中文|意思|trans|translation|meaning|def|definition)$', re.I)
IPA_HDR = re.compile(r'^(音标|ipa|phonetic|pronunciation)$', re.I)

IPA_INLINE = re.compile(r'\s*/[^/\n]{1,60}/\s*')          # 行内音标 /.../
# 词性标记：n. v. adj. …（单词与释义之间常见，不能把它算进单词）
POS_MARK = re.compile(r'(?:^|\s)((?:n|v|vt|vi|adj|adv|prep|pron|conj|num|art|int|interj|aux|abbr|pl|phr)\.)\s*', re.I)
CJK = re.compile(r'[\u4e00-\u9fff]')
EN_WORD = re.compile(r'^[A-Za-z][A-Za-z0-9\'\-\. ]*$')
BAD_CELL = re.compile(r'^(序号|星级|等级|分组|标签|来源|时间|次数|操作|idx|no\.?)$', re.I)


def clean_meaning(s):
    """释义压成单行：去掉换行、多余空白，保留分号/逗号结构"""
    s = str(s or '')
    s = s.replace('\r', ' ').replace('\n', ' ')
    s = re.sub(r'\s+', ' ', s)
    return s.strip(' \t;；,')


def pick_columns(rows):
    """找表头行；返回 (表头下标, 词列, 释义列, 音标列) 或 (None, 0, 1, None)"""
    for i, row in enumerate(rows[:8]):
        cells = [str(c).strip() for c in row]
        wi = mi = ii = None
        for j, c in enumerate(cells):
            if wi is None and WORD_HDR.match(c):
                wi = j
            elif mi is None and MEAN_HDR.match(c):
                mi = j
            elif ii is None and IPA_HDR.match(c):
                ii = j
        if wi is not None and mi is not None:
            return i, wi, mi, ii
    return None, 0, 1, None


def guess_meaning_col(row, word_col, ipa_col):
    """没有表头时猜释义列：取第一个含中文的列（跳过音标列）"""
    for j, c in enumerate(row):
        if j == word_col or j == ipa_col:
            continue
        if CJK.search(str(c or '')):
            return j
    return None


def parse_delimited(text):
    """CSV/TSV：自动试分隔符，取列数更稳定的那个"""
    best = None
    for delim in ('\t', ',', ';'):
        rows = list(csv.reader(text.splitlines(), delimiter=delim))
        width = max((len(r) for r in rows), default=0)
        score = (width, len(rows))
        if width >= 2 and (best is None or score > best[0]):
            best = (score, rows)
    return best[1] if best else None


def parse_plain_lines(text):
    """纯文本：每行 'word /ipa/ 释义' 或 'word 释义' 或 'word\\t释义'"""
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        line = re.sub(r'^\s*\d+[\s.、)）]+', '', line)          # 行首序号
        line = re.sub(r'\s*\[[^\]]*\]\s*$', '', line)          # 行尾 [星级] 之类
        has_ipa = bool(IPA_INLINE.search(line))
        line = IPA_INLINE.sub(' ', line)
        if '\t' in line:
            parts = [p.strip() for p in line.split('\t') if p.strip()]
            word, meaning = parts[0], ' '.join(parts[1:])
        elif CJK.search(line):
            idx = CJK.search(line).start()
            head = line[:idx]
            m = POS_MARK.search(head)
            if m:
                # 词性归到释义侧："codex n. 手抄本" → word=codex / meaning=n. 手抄本
                word = head[:m.start(1)].strip(' -–—:：,，;；')
                meaning = line[m.start(1):].strip()
            else:
                word = head.strip(' -–—:：,，;；')
                meaning = line[idx:].strip()
        else:
            word, meaning = line, ''
        out.append([word, meaning, '1' if has_ipa else ''])
    return out


def to_pairs(rows):
    """把各种形态的行统一成 [(word, meaning)]"""
    hdr, wcol, mcol, icol = pick_columns(rows)
    body = rows[hdr + 1:] if hdr is not None else rows
    pairs = []
    for row in body:
        if not row or not any(str(c).strip() for c in row):
            continue
        cells = [str(c).strip() for c in row]
        if wcol >= len(cells):
            continue
        word = cells[wcol]
        meaning = cells[mcol] if (mcol is not None and mcol < len(cells)) else ''
        if not meaning:
            j = guess_meaning_col(cells, wcol, icol)
            meaning = cells[j] if j is not None else ''
        # 首行没识别成表头时，第一行可能就是数据
        if hdr is None and not EN_WORD.match(word or '') and not meaning:
            continue
        pairs.append((word, meaning))
    return pairs


def normalize(pairs, max_words):
    seen = set()
    out = []
    dropped = {'empty': 0, 'not_english': 0, 'too_long': 0, 'dup': 0, 'meta': 0}
    for word, meaning in pairs:
        w = re.sub(r'\s+', ' ', str(word or '')).strip().strip('"\'').lower()
        if not w:
            dropped['empty'] += 1
            continue
        if BAD_CELL.match(w) or not EN_WORD.match(w) or not re.search(r'[a-z]', w):
            dropped['meta' if BAD_CELL.match(w) else 'not_english'] += 1
            continue
        if len(w.split(' ')) > max_words:
            dropped['too_long'] += 1
            continue
        if w in seen:
            dropped['dup'] += 1
            continue
        seen.add(w)
        out.append((w, clean_meaning(meaning)))
    return out, dropped


def main():
    ap = argparse.ArgumentParser(description='欧路词典生词本 → LexiLoop 导入用两列 CSV')
    ap.add_argument('src', help='欧路导出的 csv / tsv / txt')
    ap.add_argument('-o', '--out', help='输出路径（默认在源文件旁加 .lexiloop.csv）')
    ap.add_argument('--max-words', type=int, default=6, help='超过这个词数的条目丢弃（默认 6）')
    args = ap.parse_args()

    src = Path(args.src)
    if not src.exists():
        print('找不到文件：' + str(src))
        return 1

    raw = src.read_bytes()
    text = None
    for enc in ('utf-8-sig', 'utf-8', 'gb18030', 'big5'):
        try:
            text = raw.decode(enc)
            used = enc
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        print('无法识别文件编码（试过 utf-8 / gb18030 / big5）')
        return 1

    rows = parse_delimited(text)
    # 列数不足 2 或看起来不是表格，就按纯文本行解析
    if not rows or max((len(r) for r in rows), default=0) < 2:
        rows = parse_plain_lines(text)
        mode = '纯文本行'
    else:
        mode = '表格'

    pairs = to_pairs(rows)
    clean, dropped = normalize(pairs, args.max_words)

    out = Path(args.out) if args.out else src.with_suffix('').with_name(src.stem + '.lexiloop.csv')
    with out.open('w', encoding='utf-8-sig', newline='') as f:
        wr = csv.writer(f)
        wr.writerow(['word', '释义'])          # 我们的导入器会跳过这行表头
        for w, m in clean:
            wr.writerow([w, m])

    with_meaning = sum(1 for _, m in clean if m)
    print('源文件编码：%s　｜　解析方式：%s' % (used, mode))
    print('读入条目 %d → 输出 %d（带释义 %d）' % (len(pairs), len(clean), with_meaning))
    print('丢弃：重复 %d、非英文 %d、过长 %d、空行 %d、表头/元信息 %d' % (
        dropped['dup'], dropped['not_english'], dropped['too_long'], dropped['empty'], dropped['meta']))
    print('已写出：%s' % out)
    print('导入方式：LexiLoop → 词库 → 导入词条 → 选文件 → 不勾选 AI 生成（先建卡，稍后按需生成）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
