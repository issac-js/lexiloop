"""Read a v128+ review CSV locally; write aggregate-only JSON/Markdown, never contact cloud."""
import argparse
from collections import Counter, defaultdict
import csv
from datetime import date, datetime, timezone
import json
import math
from pathlib import Path
from statistics import median
from zoneinfo import ZoneInfo

SHANGHAI = ZoneInfo('Asia/Shanghai')
REQUIRED = {'created_at_iso', 'id', 'card_type', 'grade', 'source', 'verdict',
            'hinted', 'assisted', 'timing_schema', 'response_ms', 'feedback_ms',
            'card_type_source', 'previous_review_at', 'elapsed_ms'}
LONG_MS = 300000


def number(value):
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (TypeError, ValueError):
        return None


def timestamp(value):
    """ISO values must carry a timezone; numeric previous timestamps are JS epoch ms."""
    if value is None or str(value).strip() == '':
        return None
    numeric = number(value)
    try:
        if numeric is not None:
            return datetime.fromtimestamp(numeric / 1000, timezone.utc)
        dt = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return dt if dt.tzinfo is not None and dt.utcoffset() is not None else None
    except (ValueError, OverflowError, OSError):
        return None


def flag(value):
    return {'true': True, 'false': False}.get(str(value).lower())


def interval(row, at):
    previous = timestamp(row.get('previous_review_at'))
    if previous is None or previous > at:
        return 'unknown'
    days = (at - previous).total_seconds() / 86400
    if at.astimezone(SHANGHAI).date() == previous.astimezone(SHANGHAI).date():
        return 'same_day'
    return '<1d' if days < 1 else '1-3d' if days < 3 else '3-7d' if days < 7 else '7-14d' if days < 14 else '14d+'


def summarize(rows):
    grades = Counter(r['_grade'] for r in rows if r['_grade'] is not None)
    verdicts = Counter(r.get('verdict') or 'unknown' for r in rows)
    measured = [r for r in rows if r.get('timing_schema') == 'study_wall_v1']
    times = []
    long_n = invalid = 0
    for r in measured:
        response, feedback, total = [number(r.get(k)) for k in ('response_ms', 'feedback_ms', 'elapsed_ms')]
        if any(n is None or n < 0 for n in (response, feedback, total)) or abs(response + feedback - total) > 1:
            invalid += 1
            continue
        if total > LONG_MS:
            long_n += 1
        else:
            times.append((response, feedback, total))
    return {'n': len(rows), 'grade_n': sum(grades.values()),
            'self_grade_3_or_4': grades[3] + grades[4], 'grades': dict(sorted(grades.items())),
            'verdicts': dict(sorted(verdicts.items())), 'measured_n': len(measured),
            'timing_valid_nonlong_n': len(times), 'long_wall_n': long_n, 'invalid_timing_n': invalid,
            'response_median_ms': median(t[0] for t in times) if times else None,
            'feedback_median_ms': median(t[1] for t in times) if times else None,
            'total_median_ms': median(t[2] for t in times) if times else None}


def analyze(path, since=None, until=None):
    if since and until and since > until:
        raise ValueError('since must not be after until')
    audit = Counter()
    seen = {}
    rows = []
    with Path(path).open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream)
        missing = REQUIRED - set(reader.fieldnames or [])
        if missing:
            raise ValueError('Need a v128+ CSV; missing: ' + ', '.join(sorted(missing)))
        for row in reader:
            audit['input_rows'] += 1
            if None in row or any(v is None for v in row.values()):
                raise ValueError('Malformed CSV row %d' % reader.line_num)
            rid = row.get('id')
            if rid:
                if rid in seen:
                    if seen[rid] != row:
                        raise ValueError('Conflicting rows for the same review ID; export again')
                    audit['duplicate_rows'] += 1
                    continue
                seen[rid] = row.copy()
            else:
                audit['missing_id'] += 1
            at = timestamp(row.get('created_at_iso'))
            if at is None:
                audit['invalid_timestamp_rows'] += 1
                continue
            local_date = at.astimezone(SHANGHAI).date()
            if (since and local_date < since) or (until and local_date > until):
                audit['outside_range_rows'] += 1
                continue
            grade = number(row.get('grade'))
            row['_grade'] = int(grade) if grade in (1, 2, 3, 4) else None
            row['_date'] = local_date.isoformat()
            row['_interval'] = interval(row, at)
            # Historical booleans may be defaults rather than observed; don't treat them as evidence.
            known_flags = row.get('timing_schema') == 'study_wall_v1'
            hinted, assisted = (flag(row.get(k)) if known_flags else None for k in ('hinted', 'assisted'))
            row['_support'] = 'hinted' if hinted else 'assisted' if assisted else 'unassisted' if hinted is False and assisted is False else 'unknown'
            rows.append(row)
    def grouped(key):
        groups = defaultdict(list)
        for r in rows:
            groups[r.get(key) or 'unknown'].append(r)
        return {k: summarize(v) for k, v in sorted(groups.items())}
    dates = sorted({r['_date'] for r in rows})
    span = (date.fromisoformat(dates[-1]) - date.fromisoformat(dates[0])).days + 1 if dates else 0
    # Cross-strata prevent a change of card mix or hint use being mistaken for improvement.
    strata = defaultdict(list)
    for r in rows:
        key = '|'.join(r.get(k) or 'unknown' for k in ('source', 'card_type', 'card_type_source', '_support', '_interval'))
        strata[key].append(r)
    return {'schema': 1, 'timezone': 'Asia/Shanghai', 'audit': dict(audit),
            'range': {'since': str(since) if since else None, 'until': str(until) if until else None,
                      'first': dates[0] if dates else None, 'last': dates[-1] if dates else None,
                      'calendar_span_days': span, 'active_days': len(dates)},
            'coverage': {'at_review_card_type_n': sum(r.get('card_type_source') == 'at_review' for r in rows),
                         'known_support_n': sum(r['_support'] != 'unknown' for r in rows),
                         'known_interval_n': sum(r['_interval'] != 'unknown' for r in rows)},
            'overall': summarize(rows), 'by_source': grouped('source'), 'by_card_type': grouped('card_type'),
            'by_support': grouped('_support'), 'by_interval': grouped('_interval'),
            'by_timing_schema': grouped('timing_schema'), 'by_review_reason': grouped('review_reason'),
            'by_day': grouped('_date'), 'strata_source_card_provenance_support_interval': {k: summarize(v) for k, v in sorted(strata.items())},
            'interpretation': 'Descriptive only; no causal claim, mastery inference or FSRS parameter update. ' +
                              ('Less than 14 calendar days: preliminary.' if span < 14 else 'Check per-stratum sample size before comparing.')}


def markdown(report):
    esc = lambda v: str(v).replace('|', '\\|').replace('\n', ' ')
    out = ['# LexiLoop 学习观察', '', '仅为描述性统计；不证明因果或跨情境掌握，不自动调整 FSRS。', '',
           '时间按上海日期；计时为墙钟时间。超过 5 分钟的记录单列；中位数只用 study_wall_v1 且三段时间自洽的非长停留记录。', '',
           '样本：%d 条；跨度 %d 天；实际学习 %d 天。' % (report['overall']['n'], report['range']['calendar_span_days'], report['range']['active_days']), '',
           '覆盖：作答当时卡型 %d 条；新口径提示/辅助标记 %d 条；可计算复习间隔 %d 条。' % tuple(report['coverage'].values()), '',
           '不足 14 天仅作初步观察；达到 14 天也需逐组检查样本量。', '',
           '自评 ≥3 与系统 hit/alt 分开统计；旧记录的默认 false 不作为独立作答证据。原 CSV 最多 20000 条，本报告不能证明导出范围外没有记录。', '',
           '导入核对：' + esc(json.dumps(report['audit'], ensure_ascii=False)), '']
    for key, label in [('by_source','来源'),('by_card_type','卡型'),('by_support','辅助情况'),('by_interval','实际复习间隔'),('by_review_reason','语义复核状态'),('by_day','上海日期')]:
        out += ['## ' + label, '', '| 分组 | 样本 | 有效自评 | 自评≥3 | hit | alt | unsure | 长停留 | 作答中位秒 |',
                '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
        for name, s in report[key].items():
            med = s['response_median_ms']
            out.append('| %s | %d | %d | %d | %d | %d | %d | %d | %s |' % (esc(name), s['n'], s['grade_n'], s['self_grade_3_or_4'],
                       s['verdicts'].get('hit',0), s['verdicts'].get('alt',0), s['verdicts'].get('unsure',0), s['long_wall_n'], '—' if med is None else '%.2f' % (med/1000)))
        out.append('')
    out += ['完整 JSON 另含分层样本、字段缺口与计时分布摘要。没有足够数据时，不解释为退步或记忆困难。', '']
    return '\n'.join(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('csv', type=Path)
    parser.add_argument('--since', type=date.fromisoformat)
    parser.add_argument('--until', type=date.fromisoformat)
    parser.add_argument('--out', type=Path, required=True, help='New output directory')
    args = parser.parse_args()
    try:
        report = analyze(args.csv, args.since, args.until)
        args.out.mkdir(parents=True, exist_ok=False)
        (args.out / 'learning-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        (args.out / 'learning-report.md').write_text(markdown(report), encoding='utf-8')
    except (ValueError, OSError) as error:
        parser.error(str(error))
    print('Saved aggregate-only learning-report.json and learning-report.md')


if __name__ == '__main__':
    main()
