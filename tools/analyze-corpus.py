"""分析 Kevin 的语料库 md 的结构，为结构感知解析提供依据。"""
import collections
import json
import re
import sys

PATH = r"C:\Users\cs198\Desktop\英语表达语料库.md"

lines = open(PATH, encoding="utf-8").read().split("\n")
print("总行数", len(lines))

# 1) 标题层级
heads = collections.Counter()
h_samples = collections.defaultdict(list)
for ln in lines:
    m = re.match(r"^(#{1,6})\s+(.*)$", ln)
    if m:
        lvl = len(m.group(1))
        heads[lvl] += 1
        if len(h_samples[lvl]) < 4:
            h_samples[lvl].append(m.group(2)[:70])
print("\n标题层级分布：", dict(heads))
for lvl in sorted(h_samples):
    print("  H%d 示例：" % lvl)
    for s in h_samples[lvl]:
        print("     ", s)

# 2) 带反斜杠转义的字符统计
esc = collections.Counter(re.findall(r"\\(.)", "\n".join(lines)))
print("\n反斜杠转义字符分布（前 12）：", esc.most_common(12))

# 3) 结构关键词
for kw in ["**意思：**", "**意思**:", "**Example**", "**可替换**", "**更口语**", "**固定搭配**", "**注意"]:
    n = sum(1 for ln in lines if kw in ln)
    print("  %-14s %d 行" % (kw, n))

# 4) 若 H2 就是词条，能抽出多少条
def unescape(s):
    return re.sub(r"\\([\\`*_{}\[\]()#+\-.!>~|])", r"\1", s)

h2 = []
for ln in lines:
    m = re.match(r"^##\s+(.*)$", ln)
    if m:
        h2.append(unescape(m.group(1)).strip())
print("\nH2 数量（潜在词条数）：", len(h2))

def clean_term(t):
    t = re.sub(r"^\d{1,3}\s*[.、)）]\s*", "", t)        # 序号
    t = t.split("：")[0].split(":")[0]                   # 冒号前
    t = re.split(r"[\u4e00-\u9fff]", t)[0]              # 中文前
    t = re.sub(r"[^A-Za-z0-9'\-./ ]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip(" -–—:：,，;；.。")
    return t.strip().lower()

terms = [clean_term(t) for t in h2]
good = [t for t in terms if t and re.search(r"[a-z]", t)]
print("清洗后可用词条：", len(good))
lens = collections.Counter(len(t.split()) for t in good)
print("词数分布：", dict(sorted(lens.items())))
print("\n前 25 条：")
for t in good[:25]:
    print("   ", t)

# 5) 词长超过 5 的占比（看当前的词数上限是否会误杀）
over = [t for t in good if len(t.split()) > 5]
print("\n超过 5 个词的：%d / %d（%.0f%%）" % (len(over), len(good), 100.0 * len(over) / max(1, len(good))))
for t in over[:10]:
    print("   长条目：", t)

# 6) 有「意思」行的词条占比
meaning = sum(1 for ln in lines if "**意思" in ln)
print("\n带 **意思** 的行：%d" % meaning)
