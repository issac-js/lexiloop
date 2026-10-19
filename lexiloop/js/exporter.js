/**
 * exporter.js — 生成背诵手册（Markdown / Word）
 *
 * Word 使用真实 .docx（docx 库按需从 CDN 加载，失败时降级为 .doc 的 HTML 文档），
 * Markdown 为纯文本，无任何外部依赖。
 */

const DOCX_CDN = 'https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js'

const STRENGTH_ZH = { strong: '强', medium: '中', weak: '弱' }
const REGISTER_ZH = { formal: '正式', neutral: '中性', spoken: '口语', informal: '非正式' }

const fmtDate = (ts) => {
  const d = ts ? new Date(ts) : new Date()
  const p = (n) => (n < 10 ? '0' + n : String(n))
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function sensesLine(payload) {
  const senses = payload.senses || []
  return senses.map((s) => (s.pos ? s.pos + '. ' : '') + (s.def_zh || s.def_en)).filter(Boolean)
}

/* ─────────────────────────── Markdown ─────────────────────────── */

export function buildMarkdown(items, opts) {
  const o = opts || {}
  const L = []
  L.push('# ' + (o.title || '英语搭配背诵手册'))
  L.push('')
  L.push(
    '生成日期：' + fmtDate(o.date) +
    '　｜　词条数：' + items.length +
    '　｜　目标留存率：' + Math.round((o.retention || 0.9) * 100) + '%'
  )
  L.push('')
  L.push('> 释义与搭配由 AI 生成，仅供学习参考，请以权威词典为准。')
  L.push('')
  L.push('---')
  L.push('')

  items.forEach((item, i) => {
    const w = item.word
    const p = w.payload || {}
    const ipa = p.ipa && (p.ipa.uk || p.ipa.us)
    L.push('## ' + (i + 1) + '. ' + (p.lemma || w.lemma || w.normalized) + (ipa ? ' /' + String(ipa).replace(/\//g, '') + '/' : ''))
    L.push('')

    const senses = sensesLine(p)
    if (senses.length) {
      senses.forEach((s) => {
        L.push('- ' + s)
      })
      L.push('')
    }

    const colls = p.collocations || []
    if (colls.length) {
      L.push('### 固定搭配')
      L.push('')
      L.push('| 搭配 | 语法型 | 强度 | 语域 | 释义 |')
      L.push('| --- | --- | --- | --- | --- |')
      colls.forEach((c) => {
        L.push(
          '| ' + (c.pattern || '') +
          ' | ' + (c.type || '') +
          ' | ' + (STRENGTH_ZH[c.strength] || '中') +
          ' | ' + (REGISTER_ZH[c.register] || '中性') +
          ' | ' + (c.zh || '') + ' |'
        )
      })
      L.push('')

      L.push('### 例句')
      L.push('')
      let n = 1
      colls.forEach((c) => {
        ;(c.examples || []).forEach((e) => {
          L.push(n + '. ' + e.en)
          if (e.zh) L.push('   ' + e.zh)
          n++
        })
      })
      L.push('')
    }

    ;(p.confusables || []).length &&
      (L.push('### 易混词'), L.push(''), p.confusables.forEach((c) => L.push('- **' + c.word + '**：' + c.note)), L.push(''))

    ;(p.word_family || []).length &&
      (L.push('### 同族词'), L.push(''), L.push(p.word_family.join(' · ')), L.push(''))

    if (p.mnemonic) {
      L.push('### 助记')
      L.push('')
      L.push(p.mnemonic)
      L.push('')
    }

    if (item.card && item.card.due && item.card.status !== 'new') {
      L.push('*下次复习：' + fmtDate(new Date(item.card.due).getTime()) + '*')
      L.push('')
    }

    L.push('---')
    L.push('')
  })

  return L.join('\n')
}

/* ─────────────────────────── Word ─────────────────────────── */

let docxPromise = null
function loadDocx() {
  if (window.docx) return Promise.resolve(window.docx)
  if (docxPromise) return docxPromise
  docxPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = DOCX_CDN
    s.onload = () => (window.docx ? resolve(window.docx) : reject(new Error('docx 组件加载异常')))
    s.onerror = () => reject(new Error('docx 组件加载失败，请检查网络后重试'))
    document.head.appendChild(s)
  })
  return docxPromise
}

export async function buildDocx(items, opts) {
  const o = opts || {}
  const dx = await loadDocx()
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
    WidthType, AlignmentType, BorderStyle,
  } = dx

  const children = []
  children.push(new Paragraph({ text: o.title || '英语搭配背诵手册', heading: HeadingLevel.TITLE }))
  children.push(
    new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { after: 200 },
      children: [
        new TextRun({
          text:
            '生成日期：' + fmtDate(o.date) +
            '　词条数：' + items.length +
            '　目标留存率：' + Math.round((o.retention || 0.9) * 100) + '%',
          size: 18,
          color: '666666',
        }),
      ],
    })
  )
  children.push(
    new Paragraph({
      spacing: { after: 240 },
      children: [
        new TextRun({
          text: '释义与搭配由 AI 生成，仅供学习参考，请以权威词典为准。',
          size: 18,
          italics: true,
          color: '888888',
        }),
      ],
    })
  )

  const thin = { style: BorderStyle.SINGLE, size: 4, color: 'D9D9D9' }
  const cellBorders = { top: thin, bottom: thin, left: thin, right: thin }

  items.forEach((item, i) => {
    const w = item.word
    const p = w.payload || {}
    const ipa = p.ipa && (p.ipa.uk || p.ipa.us)

    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 280, after: 100 },
        children: [
          new TextRun({
            text: (i + 1) + '. ' + (p.lemma || w.lemma || w.normalized) + (ipa ? '  /' + String(ipa).replace(/\//g, '') + '/' : ''),
          }),
        ],
      })
    )

    sensesLine(p).forEach((s) => {
      children.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: '· ' + s })] }))
    })

    const colls = p.collocations || []
    if (colls.length) {
      children.push(
        new Paragraph({ spacing: { before: 160, after: 80 }, children: [new TextRun({ text: '固定搭配', bold: true })] })
      )
      const header = new TableRow({
        tableHeader: true,
        children: ['搭配', '语法型', '强度', '语域', '释义'].map(
          (t) =>
            new TableCell({
              borders: cellBorders,
              shading: { fill: 'F2EFF7' },
              children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, size: 18 })] })],
            })
        ),
      })
      const rows = colls.map(
        (c) =>
          new TableRow({
            children: [
              [c.pattern || '', 32],
              [c.type || '', 18],
              [STRENGTH_ZH[c.strength] || '中', 8],
              [REGISTER_ZH[c.register] || '中性', 10],
              [c.zh || '', 32],
            ].map(
              (pair) =>
                new TableCell({
                  borders: cellBorders,
                  width: { size: pair[1], type: WidthType.PERCENTAGE },
                  children: [new Paragraph({ children: [new TextRun({ text: pair[0], size: 18 })] })],
                })
            ),
          })
      )
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header].concat(rows) }))

      children.push(
        new Paragraph({ spacing: { before: 160, after: 80 }, children: [new TextRun({ text: '例句', bold: true })] })
      )
      let n = 1
      colls.forEach((c) => {
        ;(c.examples || []).forEach((e) => {
          children.push(
            new Paragraph({
              spacing: { after: 20 },
              children: [new TextRun({ text: n + '. ' + e.en, size: 21 })],
            })
          )
          if (e.zh) {
            children.push(
              new Paragraph({
                spacing: { after: 80 },
                indent: { left: 260 },
                children: [new TextRun({ text: e.zh, size: 18, color: '777777' })],
              })
            )
          }
          n++
        })
      })
    }

    if ((p.confusables || []).length) {
      children.push(
        new Paragraph({ spacing: { before: 160, after: 80 }, children: [new TextRun({ text: '易混词', bold: true })] })
      )
      p.confusables.forEach((c) => {
        children.push(
          new Paragraph({
            spacing: { after: 40 },
            children: [
              new TextRun({ text: c.word + '：', bold: true, size: 20 }),
              new TextRun({ text: c.note, size: 20 }),
            ],
          })
        )
      })
    }

    if ((p.word_family || []).length) {
      children.push(
        new Paragraph({
          spacing: { before: 140, after: 40 },
          children: [
            new TextRun({ text: '同族词：', bold: true, size: 20 }),
            new TextRun({ text: p.word_family.join(' · '), size: 20 }),
          ],
        })
      )
    }

    if (p.mnemonic) {
      children.push(
        new Paragraph({
          spacing: { before: 140, after: 40 },
          children: [
            new TextRun({ text: '助记：', bold: true, size: 20 }),
            new TextRun({ text: p.mnemonic, size: 20 }),
          ],
        })
      )
    }
  })

  const doc = new Document({
    styles: { default: { document: { run: { font: '微软雅黑', size: 21 } } } },
    sections: [{ properties: {}, children }],
  })
  return Packer.toBlob(doc)
}

/**
 * 降级方案：docx 库从 CDN 拉不到时（内网 / 断网 / CDN 被墙），
 * 生成一份 Word 可直接打开的 HTML 文档（.doc 后缀）。
 * 排版比真 .docx 朴素，但保证"导得出"，而不是弹一个失败。
 */
export function buildDocHtml(items, opts) {
  const o = opts || {}
  const e = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const L = []
  L.push('<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">')
  L.push('<head><meta charset="utf-8"><title>' + e(o.title || '英语搭配背诵手册') + '</title>')
  L.push('<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->')
  L.push('<style>body{font-family:"Microsoft YaHei";font-size:11pt;}')
  L.push('h1{font-size:19pt;} h2{font-size:14pt;margin-top:16pt;} h3{font-size:12pt;margin-top:10pt;}')
  L.push('table{border-collapse:collapse;width:100%;} td,th{border:1px solid #999;padding:4pt;font-size:10pt;}')
  L.push('.zh{color:#666;} .meta{color:#888;font-size:9pt;} </style></head><body>')
  L.push('<h1>' + e(o.title || '英语搭配背诵手册') + '</h1>')
  L.push('<p class="meta">生成日期：' + e(fmtDate(o.date)) + '　词条数：' + items.length +
    '　目标留存率：' + Math.round((o.retention || 0.9) * 100) + '%</p>')
  L.push('<p class="meta"><i>释义与搭配由 AI 生成，仅供学习参考，请以权威词典为准。（离线降级版）</i></p>')

  items.forEach((item, i) => {
    const w = item.word || {}
    const p = w.payload || {}
    const ipa = p.ipa && (p.ipa.uk || p.ipa.us)
    L.push('<h2>' + (i + 1) + '. ' + e(p.lemma || w.lemma || w.normalized) +
      (ipa ? '  /' + e(String(ipa).replace(/\//g, '')) + '/' : '') + '</h2>')

    const senses = sensesLine(p)
    if (senses.length) L.push('<ul>' + senses.map((s) => '<li>' + e(s) + '</li>').join('') + '</ul>')

    const colls = p.collocations || []
    if (colls.length) {
      L.push('<h3>固定搭配</h3>')
      L.push('<table><tr><th>搭配</th><th>语法型</th><th>强度</th><th>语域</th><th>释义</th></tr>')
      colls.forEach((c) => {
        L.push('<tr><td>' + e(c.pattern) + '</td><td>' + e(c.type) + '</td><td>' +
          e(STRENGTH_ZH[c.strength] || '中') + '</td><td>' + e(REGISTER_ZH[c.register] || '中性') +
          '</td><td>' + e(c.zh) + '</td></tr>')
      })
      L.push('</table>')
      L.push('<h3>例句</h3><ol>')
      colls.forEach((c) => {
        (c.examples || []).forEach((ex) => {
          L.push('<li>' + e(ex.en) + (ex.zh ? '<br><span class="zh">' + e(ex.zh) + '</span>' : '') + '</li>')
        })
      })
      L.push('</ol>')
    }

    if ((p.confusables || []).length) {
      L.push('<h3>易混词</h3><ul>')
      p.confusables.forEach((c) => L.push('<li><b>' + e(c.word) + '</b>：' + e(c.note) + '</li>'))
      L.push('</ul>')
    }
    if ((p.word_family || []).length) L.push('<p><b>同族词：</b>' + e(p.word_family.join(' · ')) + '</p>')
    if (p.mnemonic) L.push('<p><b>助记：</b>' + e(p.mnemonic) + '</p>')
  })

  L.push('</body></html>')
  return L.join('\n')
}

/**
 * 导出 Word：优先真 .docx，失败自动降级为 .doc（HTML）。
 * @returns {{blob:Blob, ext:string, degraded:boolean, reason:string}}
 */
export async function exportDocx(items, opts) {
  try {
    const blob = await buildDocx(items, opts)
    return { blob, ext: 'docx', degraded: false, reason: '' }
  } catch (err) {
    const html = buildDocHtml(items, opts)
    return {
      blob: new Blob([html], { type: 'application/msword;charset=utf-8' }),
      ext: 'doc',
      degraded: true,
      reason: (err && err.message) || 'docx 组件不可用',
    }
  }
}

/* ─────────────────────────── 下载 ─────────────────────────── */

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export function downloadText(text, filename, mime) {
  downloadBlob(new Blob([text], { type: (mime || 'text/markdown') + ';charset=utf-8' }), filename)
}

/** 小程序/微信内置浏览器等无法直接下载时，退回剪贴板 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (e) {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch (e2) {
      return false
    }
  }
}

export function stampName(base, ext) {
  const d = new Date()
  const p = (n) => (n < 10 ? '0' + n : String(n))
  return base + '-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.' + ext
}

/** Anki 可直接导入的 TSV（带文件头声明分隔符与标签列） */
export function buildAnkiCsv(items) {
  const q = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'
  const L = ['#separator:tab', '#html:false', '#tags column:3']
  items.forEach((x) => {
    const w = x.word || {}
    const card = x.card || {}
    const p = w.payload || {}
    const zh = ((p.senses || [])[0] || {}).def_zh || ''
    const c0 = (p.collocations || [])[0] || {}
    const ex = ((c0.examples || [])[0] || {})
    const back = [
      zh,
      c0.pattern ? c0.pattern + (c0.zh ? '　' + c0.zh : '') : '',
      ex.en ? ex.en + (ex.zh ? '　' + ex.zh : '') : '',
    ].filter(Boolean).join('\n')
    const tags = [String(card.deck || '').replace(/\s+/g, '-'), card.card_type || 'recognition']
      .filter(Boolean).join(' ')
    L.push([q(w.lemma || w.normalized), q(back), q(tags)].join('\t'))
  })
  return L.join('\n')
}

/** 复习记录 CSV：date,word,card_type,grade,elapsed_ms —— 供自己分析遗忘规律 */
export function buildReviewsCsv(rows) {
  const q = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'
  const L = ['date,word,card_type,grade,grade_label,elapsed_ms']
  const LABEL = { 1: '忘了', 2: '吃力', 3: '记得', 4: '很简单' }
  rows.forEach((r) => {
    L.push([
      q(String(r.created_at || '').slice(0, 19).replace('T', ' ')),
      q(r.word || ''),
      q(r.card_type || ''),
      String(r.grade || ''),
      q(LABEL[r.grade] || ''),
      String(r.elapsed_ms == null ? '' : r.elapsed_ms),
    ].join(','))
  })
  return L.join('\n')
}
