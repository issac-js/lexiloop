/**
 * importer.js — 词单导入解析
 *
 * 支持四种来源，全部在同一遍扫描里处理：
 *   1. 纯文本行         commit
 *   2. 带释义           commit　犯罪   /   commit, 犯罪   /   commit | 犯罪   /   commit<TAB>犯罪
 *   3. Markdown 文档    标题、列表、加粗、行内代码、链接、代码块、引用、YAML front matter
 *   4. Markdown 表格    | commit | 犯罪 | … （取第一列，自动跳过 |---| 分隔行）
 *
 * 设计原则：宁可漏掉一行，也不要把 `##` `**` 这类符号带进词条。
 */

/**
 * 去掉 Markdown 的反斜杠转义。
 * 大量文档是从 docx 转出来的，`\.` `\>` `\-` `\*` `\_` 随处可见；
 * 不先还原，`1\. xxx` 既认不出列表序号，`\>` 也认不出引用。
 */
export function unescapeMarkdown(s) {
  return String(s == null ? '' : s).replace(/\\([\\`*_{}\[\]()#+\-.!>~|=$])/g, '$1')
}

/** 从一行里剥掉所有 Markdown 语法，只留下文字 */
export function stripMarkdown(line) {
  let s = unescapeMarkdown(line)
  s = s.replace(/\r$/, '')
  s = s.replace(/^\s{0,3}>\s?/, '')                 // 引用 >
  s = s.replace(/^\s*[-*+]\s*\[[ xX]\]\s*/, '')     // 任务列表 - [x]
  s = s.replace(/^\s*[-*+•·]\s+/, '')               // 无序列表
  s = s.replace(/^\s*\d{1,3}\s*[.、)）]\s*/, '')      // 有序列表 1. 2) 3、
  s = s.replace(/^\s*[a-zA-Z]\s*[.)）]\s+/, '')       // 字母序号 a. b) c、（文档章节常见）
  s = s.replace(/^\s*#{1,6}\s*/, '')                // ATX 标题
  s = s.replace(/^\s*={2,}\s*$/, '')                // Setext 标题下划线
  s = s.replace(/`/g, '')                            // 行内代码
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '')         // 图片整体丢弃（alt 多是文件名）
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')      // 链接 → 保留文字
  s = s.replace(/\*\*|__/g, '')                      // 加粗
  s = s.replace(/(^|[\s(])\*([^*]+)\*(?=[\s).,!?:;]|$)/g, '$1$2') // 斜体
  s = s.replace(/(^|[\s(])_([^_]+)_(?=[\s).,!?:;]|$)/g, '$1$2')
  s = s.replace(/~~/g, '')                           // 删除线
  return s.trim()
}

/** 表格分隔行 |---|:--:|---| */
function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
}

function isFenceOrRule(line) {
  const t = line.trim()
  if (/^(```|~~~)/.test(t)) return true
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return true
  if (/^<\/?[a-zA-Z][^>]*>$/.test(t)) return true   // 裸 HTML 标签行
  return false
}

/** 取表格行的第一列 */
function firstCell(line) {
  const cells = line.split('|')
  // 前导 | 会切出一个空串
  for (const c of cells) {
    const v = stripMarkdown(c)
    if (v) return v
  }
  return ''
}

/**
 * 从一行文本里抽出真正的词条。
 * 关键启发式：词条是**开头的英文片段** —— 遇到中文、IPA 斜杠就截断。
 */
/**
 * 是不是表头行。粘贴 CSV / TSV 时第一步就撞上，必须和"文件上传"路径一样跳过，
 * 否则 "word,meaning" 会被当成一个词条导入。
 */
export function isHeaderLine(line) {
  const t = String(line || '').trim()
  if (!t || t.length > 40) return false
  // 单列表头（word / 单词 / term…）
  if (/^(words?|terms?|entries|expressions?|phrases?|english|单词|词条|词组|表达|英文)$/i.test(t)) return true
  // 带分隔符的表头（word,meaning / 单词\t释义 …）且首字段本身是表头词
  const first = t.split(/[,，\t|;；]/)[0].trim()
  return /^(words?|terms?|entries|expressions?|phrases?|english|单词|词条|词组|表达|英文)$/i.test(first)
}

export function extractTerm(line) {
  let s = stripMarkdown(line)
  if (!s) return ''

  if (s.indexOf('|') >= 0) {
    const cell = firstCell(s)
    if (cell) s = cell
  }

  // 制表符 / 竖线分隔：只取第一个字段
  s = s.split(/[\t|]+/)[0]

  // 音标：/.../ 之前的部分才是词条（要求成对斜杠，避免误伤 and/or）
  s = s.split(/\s+\/[^/\n]{1,40}\/\s*/)[0]

  // 中文注释之前的部分
  s = s.split(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/)[0]

  // 括号里的中文词性说明 vt./n./adj.
  s = s.replace(/\s*[(（][^)）]*[)）]\s*$/, '')

  // 兜底：清掉所有不属于英文词条形态的字符（残留的 # * | 等一律丢弃）
  s = s.replace(/[^a-zA-Z0-9'\-./ ]+/g, ' ')

  s = s.replace(/^[\s\-–—:：,，;；.。/]+/, '')
  s = s.replace(/[\s\-–—:：,，;；.。/]+$/, '')
  s = s.replace(/\s+/g, ' ')

  return s.trim().toLowerCase()
}

/** 默认最多几个词。整份学习文档里最容易被误收的就是例句，用词数挡住它们。 */
export const DEFAULT_MAX_WORDS = 5
/** 结构化文档里词条由标题明确标出，不需要靠词数兜底，放宽得多 */
export const STRUCTURED_MAX_WORDS = 14

/** 判定是不是一个可用的英文词条 */
export function isUsableTerm(term) {
  if (!term) return false
  if (term.length > 60) return false
  if (!/[a-z]/.test(term)) return false
  if (!/^[a-z][a-z0-9'\-. /]*$/.test(term)) return false   // 允许字母数字与常见连接符（含 and/or）
  if (term.replace(/[^a-z]/g, '').length < 2) return false
  return true
}

function wordCount(term) {
  return term.split(/\s+/).filter(Boolean).length
}

/* ─────────────────── 结构感知解析 ───────────────────
   很多学习文档是有固定骨架的：

     # 07. 邮件表达          ← 章节（H1）
     ## copy sb. on an email  ← 词条（H2）
     **抄送某人**             ← 中文释义（独占一行的加粗）
     > We've copied ...       ← 英文例句
     > 我们已将...             ← 例句翻译

   按骨架取词条，比「逐行只要有字母就收」准得多，也不会被例句淹没。 */

/** 判断是不是一份结构化词单：H2 标题够多，且多数标题本身就是英文词条 */
export function looksStructured(text) {
  const lines = String(text || '').split(/\r?\n/)
  let h2 = 0
  let usable = 0
  for (const ln of lines) {
    const m = /^##\s+(.*)$/.exec(ln.trim())
    if (!m) continue
    h2++
    const t = headingToTerm(m[1])
    if (/[a-z]/.test(t) && wordCount(t) <= STRUCTURED_MAX_WORDS) usable++
  }
  return h2 >= 3 && usable >= Math.ceil(h2 * 0.6)
}

/** 从 H2 标题里抽词条名 */
function headingToTerm(raw) {
  let s = unescapeMarkdown(raw)
  s = s.replace(/^\s*\d{1,4}\s*[.、)）]\s*/, '')          // 1. / 2、 / 3)
  s = s.replace(/^\s*[a-zA-Z]\s*[.)）]\s+/, '')            // a. / b) 字母序号
  s = s.replace(/\s*[（(][^)）]*[)）]\s*$/, '')
  s = s.split(/[：:]/)[0]                                 // 冒号前
  s = s.split(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/)[0]  // 中文前
  s = s.replace(/[^a-zA-Z0-9'\-./ ]+/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/^[\s\-–—:：,，;；.。]+/, '').replace(/[\s\-–—:：,，;；.。]+$/, '')
  return s.trim().toLowerCase()
}

function hasCJK(s) {
  return /[\u4e00-\u9fff]/.test(s)
}

/**
 * 按文档骨架解析。
 * @returns {{entries:Array<{term:string,meaning:string,examples:Array,section:string}>}}
 */
export function parseStructured(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/)
  const entries = []
  let section = ''
  let cur = null

  const push = () => {
    if (cur && cur.term) entries.push(cur)
    cur = null
  }

  for (const raw of lines) {
    const trimmed = raw.trim()

    const h1 = /^#\s+(.+)$/.exec(trimmed)
    if (h1) {
      push()
      section = unescapeMarkdown(h1[1]).replace(/^\s*\d{1,4}\s*[.、)）]\s*/, '').trim()
      continue
    }

    const h2 = /^##\s+(.+)$/.exec(trimmed)
    if (h2) {
      push()
      cur = { term: headingToTerm(h2[1]), meaning: '', examples: [], section }
      continue
    }

    if (!trimmed) continue
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) continue

    // 引用行有两种含义，必须在「不属于任何条目就跳过」之前处理：
    //   1. 「> 词条 --- 释义」的列表式词条（章节下的词汇清单常见）
    //   2. 当前条目下的例句
    const q = /^>\s?(.*)$/.exec(trimmed)
    if (q) {
      const v = unescapeMarkdown(q[1]).replace(/\\$/, '').trim()
      if (!v) continue

      const arrow = /^(.+?)\s*-{2,}\s*(.+)$/.exec(v)
      if (arrow && /[A-Za-z]{2}/.test(arrow[1]) && wordCount(arrow[1].trim()) <= 4) {
        const term = headingToTerm(arrow[1])
        if (term) {
          push()
          entries.push({
            term,
            meaning: unescapeMarkdown(arrow[2]).replace(/^["“]|["”]$/g, '').trim(),
            examples: [],
            section,
          })
        }
        continue
      }

      if (!cur) continue
      const last = cur.examples[cur.examples.length - 1]
      if (hasCJK(v)) {
        if (last && !last.zh) last.zh = v
      } else if (/[A-Za-z]{2}/.test(v)) {
        cur.examples.push({ en: v, zh: '' })
      }
      continue
    }

    if (!cur) continue
    // H3 及更深：本条目下的中文小标题，忽略
    if (/^#{3,6}\s+/.test(trimmed)) continue

    // 独占一行的加粗 = 中文释义；但「**背诵逻辑：**」这类是版式标签，不是释义
    const boldOnly = /^\*\*(.+?)\*\*$/.exec(trimmed)
    if (boldOnly && !cur.meaning) {
      const v = unescapeMarkdown(boldOnly[1]).trim()
      if (v && !/[：:]$/.test(v)) cur.meaning = v
      continue
    }

    // 行内的「**意思：** xxx」也算释义
    const inline = /^\*\*(?:意思|释义|含义)[：:]\*\*\s*(.+)$/.exec(trimmed)
    if (inline && !cur.meaning) {
      cur.meaning = unescapeMarkdown(inline[1]).trim()
    }
  }
  push()

  return { entries }
}

/**
 * 解析导入文本。
 * @param {string} text
 * @param {{maxWords?:number, structured?:boolean}} [opts]
 * @returns {{terms:string[], entries:Array, mode:string,
 *            stats:{total:number,kept:number,skipped:number,duplicates:number,tooLong:number,withMeaning:number}}}
 */
export function parseImport(text, opts) {
  const o = opts || {}

  // 结构化文档优先走骨架解析
  const useStructured = o.structured === true || (o.structured !== false && looksStructured(text))
  if (useStructured) return parseAsStructure(text, o)

  return parseFlat(text, o)
}

function parseAsStructure(text, o) {
  const limit = o.maxWords && o.maxWords !== DEFAULT_MAX_WORDS ? o.maxWords : STRUCTURED_MAX_WORDS
  const { entries } = parseStructured(text)
  const seen = new Set()
  const out = []
  let skipped = 0
  let duplicates = 0
  let tooLong = 0
  let withMeaning = 0

  entries.forEach((e) => {
    const term = e.term
    if (!isUsableTerm(term) || term.indexOf('·') >= 0) {
      skipped++
      return
    }
    if (wordCount(term) > limit) {
      tooLong++
      skipped++
      return
    }
    if (seen.has(term)) {
      duplicates++
      return
    }
    seen.add(term)
    const examples = e.examples
      .filter((x) => x.en && x.en.split(/\s+/).length >= 3)
      .slice(0, 3)
    out.push({ term, meaning: e.meaning || '', examples, section: e.section || '' })
    if (e.meaning) withMeaning++
  })

  return {
    terms: out.map((e) => e.term),
    entries: out,
    mode: 'structured',
    stats: {
      total: entries.length,
      kept: out.length,
      skipped,
      duplicates,
      tooLong,
      withMeaning,
    },
  }
}

function parseFlat(text, opts) {
  const limit = (opts && opts.maxWords) || DEFAULT_MAX_WORDS
  const lines = String(text == null ? '' : text).split(/\r?\n/)
  const terms = []
  const seen = new Set()
  let total = 0
  let skipped = 0
  let duplicates = 0
  let tooLong = 0

  let inFence = false
  let inFrontMatter = false
  let frontMatterDone = false

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()

    // YAML front matter：仅当首行是 --- 时生效
    if (!frontMatterDone && i === 0 && /^---\s*$/.test(trimmed)) {
      inFrontMatter = true
      continue
    }
    if (inFrontMatter) {
      if (/^---\s*$/.test(trimmed)) {
        inFrontMatter = false
        frontMatterDone = true
      }
      continue
    }

    // 代码块整体跳过（里面的内容通常不是词条清单）
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    if (!trimmed) continue
    // 表头行：粘贴 CSV/TSV 时同样要跳过，否则 "word,meaning" 会被当成一个词条导入
    if (isHeaderLine(unescapeMarkdown(trimmed))) {
      skipped++
      continue
    }
    // 引用块在词单文档里几乎都是说明或例句，收进来只会污染词库
    if (/^\s{0,3}>/.test(unescapeMarkdown(raw))) {
      total++
      skipped++
      continue
    }
    if (isFenceOrRule(unescapeMarkdown(trimmed))) continue
    if (isTableSeparator(unescapeMarkdown(trimmed))) continue

    total++
    const term = extractTerm(trimmed)
    if (!isUsableTerm(term)) {
      skipped++
      continue
    }
    if (wordCount(term) > limit) {
      tooLong++
      skipped++
      continue
    }
    if (seen.has(term)) {
      duplicates++
      continue
    }
    seen.add(term)
    terms.push(term)
  }

  return {
    terms,
    entries: terms.map((t) => ({ term: t, meaning: '', examples: [], section: '' })),
    mode: 'flat',
    stats: { total, kept: terms.length, skipped, duplicates, tooLong, withMeaning: 0 },
  }
}

/**
 * 列出被跳过的行与原因 —— 导入只报"跳过 N 条"时，用户没法知道到底哪几行没了。
 * @returns {Array<{line:string, reason:string}>}
 */
export function skippedLines(text, opts) {
  const o = opts || {}
  const lines = String(text == null ? '' : text).split(/\r?\n/)
  const out = []
  const useStructured = o.structured === true || (o.structured !== false && looksStructured(text))

  if (useStructured) {
    const { entries } = parseStructured(text)
    const seen = new Set()
    entries.forEach((e) => {
      const t = e.term
      if (!t) { out.push({ line: '（空标题）', reason: '标题里没有英文词条' }); return }
      if (t.indexOf('·') >= 0) { out.push({ line: t, reason: '含分隔符，不像词条' }); return }
      if (!isUsableTerm(t)) { out.push({ line: t, reason: '不像英文词条' }); return }
      if (wordCount(t) > STRUCTURED_MAX_WORDS) {
        out.push({ line: t, reason: '太长（超过 ' + STRUCTURED_MAX_WORDS + ' 个词，疑似句子）' })
        return
      }
      if (seen.has(t)) { out.push({ line: t, reason: '与前面重复' }); return }
      seen.add(t)
    })
    return out
  }

  const limit = o.maxWords || DEFAULT_MAX_WORDS
  const seen = new Set()
  let inFence = false
  let inFrontMatter = false
  let frontMatterDone = false

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (!frontMatterDone && i === 0 && /^---\s*$/.test(trimmed)) { inFrontMatter = true; continue }
    if (inFrontMatter) {
      if (/^---\s*$/.test(trimmed)) { inFrontMatter = false; frontMatterDone = true }
      continue
    }
    if (/^(```|~~~)/.test(trimmed)) { inFence = !inFence; continue }
    if (inFence) continue
    if (!trimmed) continue
    if (/^\s{0,3}>/.test(unescapeMarkdown(raw))) {
      out.push({ line: trimmed.slice(0, 80), reason: '引用行（多数是例句或说明，不收）' })
      continue
    }
    if (isFenceOrRule(unescapeMarkdown(trimmed))) continue
    if (isTableSeparator(unescapeMarkdown(trimmed))) continue

    const term = extractTerm(trimmed)
    if (!isUsableTerm(term)) {
      out.push({ line: trimmed.slice(0, 80), reason: term ? '解析结果「' + term + '」不像英文词条' : '没解析出英文词条' })
      continue
    }
    if (wordCount(term) > limit) {
      out.push({ line: term, reason: '超过 ' + limit + ' 个词（疑似句子，调大上限可收录）' })
      continue
    }
    if (seen.has(term)) { out.push({ line: term, reason: '与前面重复' }); continue }
    seen.add(term)
  }
  return out
}

/** 兼容旧调用：只要词条数组 */
export function parseTerms(text, opts) {
  return parseImport(text, opts).terms
}

// 供测试使用
export const __internal = { isTableSeparator, isFenceOrRule, firstCell, wordCount, headingToTerm }
