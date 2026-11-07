"""Synthetic exports only; no real user records."""
import csv
from datetime import date
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('analysis', Path(__file__).with_name('analyze_learning.py'))
A = importlib.util.module_from_spec(spec)
spec.loader.exec_module(A)

class AnalysisTest(unittest.TestCase):
    def row(self, **overrides):
        return dict(created_at_iso='2026-11-07T16:30:00Z', id='1', card_type='cloze', grade='3', source='study',
                    verdict='alt', hinted='false', assisted='false', timing_schema='study_wall_v1', response_ms='2000',
                    feedback_ms='1000', elapsed_ms='3000', card_type_source='at_review', previous_review_at='2026-11-06T16:30:00Z',
                    review_reason='reviewed', **overrides)
    def analyze(self, rows, **kwargs):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'export.csv'
            with path.open('w', encoding='utf-8-sig', newline='') as stream:
                writer = csv.DictWriter(stream, fieldnames=rows[0].keys())
                writer.writeheader(); writer.writerows(rows)
            return A.analyze(path, **kwargs)
    def test_timezone_duplicates_and_cutoff(self):
        r = self.row()
        out = self.analyze([r,r], since=date(2026,11,8), until=date(2026,11,8))
        self.assertEqual(out['overall']['n'],1)
        self.assertEqual(out['range']['first'],'2026-11-08')
        self.assertEqual(out['audit']['duplicate_rows'],1)
        self.assertEqual(out['by_interval']['1-3d']['n'],1)
        self.assertEqual(out['overall']['verdicts'],{'alt':1})
        self.assertEqual(out['overall']['response_median_ms'],2000)
    def test_legacy_unknown_and_long_pause_not_merged(self):
        rows = [self.row(), self.row() | dict(id='2', timing_schema='legacy_or_other', response_ms='',feedback_ms='',elapsed_ms='1'),
                self.row() | dict(id='3', response_ms='600000', elapsed_ms='601000')]
        out = self.analyze(rows)
        self.assertEqual(out['by_support']['unknown']['n'],1)
        self.assertEqual(out['overall']['long_wall_n'],1)
        self.assertEqual(out['overall']['timing_valid_nonlong_n'],1)
        self.assertEqual(out['overall']['response_median_ms'],2000)
    def test_invalid_and_conflicting_rows(self):
        out = self.analyze([self.row() | dict(created_at_iso='2026-11-07T16:30:00')])
        self.assertEqual(out['overall']['n'],0)
        self.assertEqual(out['audit']['invalid_timestamp_rows'],1)
        with self.assertRaises(ValueError): self.analyze([self.row(), self.row() | dict(grade='1')])
    def test_unknown_flags_and_clock_errors_do_not_infer_independence(self):
        out = self.analyze([self.row() | dict(hinted='', elapsed_ms='-1', previous_review_at='2028-01-01T00:00:00Z')])
        self.assertEqual(out['by_support']['unknown']['n'],1)
        self.assertEqual(out['coverage']['known_interval_n'],0)
        self.assertEqual(out['overall']['invalid_timing_n'],1)
        self.assertNotIn('2026-11-07T', A.markdown(out))
    def test_same_day_and_epoch_ms(self):
        out = self.analyze([self.row() | dict(previous_review_at=str(A.timestamp('2026-11-07T16:00:00Z').timestamp()*1000))])
        self.assertEqual(out['by_interval']['same_day']['n'],1)
    def test_empty_and_old_header_fail_truthfully(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'old.csv';p.write_text('date,grade\n2026-11-07,3\n')
            with self.assertRaises(ValueError): A.analyze(p)
        out=self.analyze([self.row()],since=date(2027,1,1))
        self.assertEqual(out['overall']['n'],0)
        self.assertIsNone(out['overall']['response_median_ms'])

if __name__ == '__main__': unittest.main()
