/** 生成回填 SQL：把语料库文档里每个词条的章节写进 words.payload.topic */
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const imp = await import(pathToFileURL('C:/Users/cs198/WorkBuddy/2026-09-27-10-29-27/lexiloop/js/importer.js').href)
const { parseStructured } = imp

const doc = readFileSync('C:/Users/cs198/Desktop/英语表达语料库.md', 'utf8')
const { entries } = parseStructured(doc)

const rows = []
const seen = new Set()
for (const e of entries) {
  if (!e.term || !e.section) continue
  if (seen.has(e.term)) continue
  if (e.term.length > 40) continue          // 过长的不是词条
  if (/corpus|语料库/i.test(e.section) && e.term.length > 30) continue
  seen.add(e.term)
  rows.push([e.term, e.section])
}
console.log('词条→章节 映射：', rows.length)

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"
const values = rows.map(([t, sec]) => '(' + q(t) + ',' + q(sec) + ')').join(',')
const sql =
  'WITH m(term, topic) AS (VALUES ' + values + ') ' +
  "UPDATE words SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('topic', m.topic), " +
  'updated_at = now() FROM m WHERE words.normalized = m.term'
writeFileSync('C:/Users/cs198/WorkBuddy/2026-09-27-10-29-27/tools/backfill-topic.sql', sql)
console.log('SQL 长度：', sql.length)
console.log('章节示例：', rows.slice(0, 3))
