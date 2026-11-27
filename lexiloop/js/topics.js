import * as S from './store.js?v=137'
import { $, closeModal, esc, openModal, speak } from './ui.js?v=137'
import { copyText } from './exporter.js?v=137'
import { workplaceTopics } from './topic-content.js?v=137'

let selected = ''
let query = ''
const expandedSections = new Set()
const normalizeSearch = (value) => value.trim().toLowerCase().normalize('NFKC')
const favoritesKey = () => 'lexiloop.workplace-topic-favorites.' + (S.state.user?.id ?? 'local')

function favorites() {
  try {
    const ids = JSON.parse(localStorage.getItem(favoritesKey()))
    return new Set(Array.isArray(ids) ? ids : [])
  } catch (_) {
    return new Set()
  }
}

function matchesTopic(topic, value) {
  const labels = Object.values(topic.expressions).flatMap(([term, meaning, note]) => [term, meaning, note])
  const phrases = [...topic.intake, ...topic.handover].flat()
  const pool = normalizeSearch([topic.title, topic.subtitle, topic.keywords, ...labels, ...phrases].join(' '))
  return normalizeSearch(value).split(/\s+/).every((term) => pool.includes(term))
}

function topicList() {
  const saved = favorites()
  const visible = workplaceTopics.filter((topic) => matchesTopic(topic, query))
  visible.sort((a, b) => Number(saved.has(b.id)) - Number(saved.has(a.id)))
  return visible.length
    ? visible.map((topic) => '<button class="card topic-choice" type="button" data-topic-open="' + esc(topic.id) + '">' +
      '<strong>' + esc(topic.title) + (saved.has(topic.id) ? ' <span class="tiny">已收藏</span>' : '') + '</strong>' +
      '<span class="tiny">' + esc(topic.subtitle) + '</span></button>').join('')
    : '<p class="tiny">没有找到匹配的专题，试试「受伤」或「liability」。</p>'
}

function phraseRows(lines, offset) {
  return lines.map(([zh, en], index) => '<div class="topic-phrase">' +
    '<div><div class="tiny">' + esc(zh) + '</div><p lang="en">' + esc(en) + '</p></div>' +
    '<div class="topic-actions"><button type="button" class="btn sm" data-topic-voice="' + (index + offset) + '">朗读</button>' +
    '<button type="button" class="btn sm" data-topic-copy="' + (index + offset) + '">复制</button></div></div>').join('')
}

function reportParagraph(raw) {
  return raw.split(/\[\[([^\]]+)\]\]/g).map((part, index) => {
    if (index % 2 === 0) return esc(part)
    const [text, key = text] = part.split('|')
    return '<button class="topic-expression" type="button" data-topic-expression="' + esc(key) + '">' + esc(text) + '</button>'
  }).join('')
}

function disclosure(section, title, card = false) {
  const expanded = expandedSections.has(selected + '/' + section)
  return '<details class="' + (card ? 'card tight ' : '') + 'topic-disclosure" data-topic-section="' + section +
    '"' + (expanded ? ' open' : '') + '><summary>' + title + '</summary>'
}

export function renderTopics() {
  const topic = workplaceTopics.find((item) => item.id === selected)
  if (!topic) return '<div class="field"><label for="topic-search">搜索专题</label>' +
    '<input id="topic-search" class="input" type="search" placeholder="中文主题或英文表达" value="' + esc(query) + '"></div>' +
    '<div id="topic-list">' + topicList() + '</div>'

  const saved = favorites().has(topic.id)
  return '<section class="workplace-topic" aria-labelledby="topic-title">' +
    '<div class="row between topic-toolbar"><button type="button" class="btn sm" id="topic-back">全部专题</button>' +
    '<button type="button" class="btn sm" id="topic-save" aria-pressed="' + saved + '">' + (saved ? '已收藏' : '收藏') + '</button></div>' +
    '<h2 id="topic-title" tabindex="-1">' + esc(topic.title) + '</h2>' +
    '<div class="card tight topic-quick"><h3>接听问询</h3>' + phraseRows(topic.intake, 0) +
    '<h3>交班表述</h3>' + phraseRows(topic.handover, topic.intake.length) + '</div>' +
    disclosure('report', '交班范文', true) +
    '<p class="tiny">虚构案例 · 点击加粗表达查看用法</p>' +
    topic.report.map((line) => '<p lang="en">' + reportParagraph(line) + '</p>').join('') +
    '<div class="topic-actions"><button type="button" class="btn sm" id="topic-report-voice">朗读范文</button></div>' +
    disclosure('translation', '中文译文') +
    topic.translation.map((line) => '<p>' + esc(line) + '</p>').join('') + '</details></details>' +
    disclosure('glossary', '核心搭配', true) + '<div class="topic-actions">' +
    Object.entries(topic.expressions).map(([key, [label]]) =>
      '<button type="button" class="btn sm" lang="en" data-topic-expression="' + esc(key) + '">' + esc(label) + '</button>').join('') +
    '</div></details>' +
    disclosure('exercise', '换个情境说一遍', true) +
    '<p>' + esc(topic.exercise.cue) + '</p>' + disclosure('answer', '查看参考表达') +
    '<p lang="en">' + esc(topic.exercise.answer) + '</p><p class="tiny"><strong>自查</strong> ' +
    esc(topic.exercise.check) + '</p></details></details></section>'
}

function showExpression(expression, showWord) {
  const [term, meaning, note, lookup] = expression
  openModal('<h3 lang="en">' + esc(term) + '</h3><p>' + esc(meaning) + '</p>' +
    '<p class="sub">' + esc(note) + '</p><div id="topic-word-actions" class="topic-actions"></div>' +
    '<div class="modal-actions"><button type="button" class="btn sm" id="topic-term-voice">朗读</button>' +
    '<button type="button" class="btn sm" id="topic-term-close">关闭</button></div>')
  $('#topic-term-voice').onclick = () => readAloud(term)
  $('#topic-term-close').onclick = closeModal
  const panel = $('#topic-word-actions')
  const keys = [lookup].flat().filter(Boolean)
  if (!keys.length) return
  const canStudy = (word) => word && !S.isBlockedWord(word)
  const hasCard = (card, word) => String(card.word_id) === String(word.id)
  const bindWord = (word) => {
    if (!panel.isConnected) return
    if (!word) {
      panel.textContent = '本表达可在专题中查阅。'
      return
    }
    const cards = S.state.cards.filter((card) => hasCard(card, word))
    if (cards.length) {
      panel.innerHTML = '<button type="button" class="btn sm" id="topic-open-word">查看原词卡</button>'
      $('#topic-open-word').onclick = () => showWord(word, cards)
      return
    }
    panel.innerHTML = '<button type="button" class="btn sm" id="topic-add-card">加入复习</button>'
    const button = $('#topic-add-card')
    button.onclick = async () => {
      button.disabled = true
      try {
        await S.createCards([{
          word_id: word.id,
          deck: S.state.settings.deck || '默认词单',
          card_type: 'recognition',
          batch: S.newBatchId(),
          status: 'new',
          due: new Date().toISOString(),
        }])
      } catch (_) {
        if (panel.isConnected) {
          button.disabled = false
          notifyTopic('添加失败，请稍后重试。', panel)
        }
        return
      }
      if (panel.isConnected) panel.textContent = '已加入复习，可在词库查看。'
      S.syncPull().catch(() => {})
    }
  }
  // A phrase can be stored under its headword. Prefer a word the learner already studies.
  const local = keys.map((key) => S.state.words.find((word) => word.normalized === key))
  const available = local.filter(canStudy)
  const existing = available.find((word) => S.state.cards.some((card) => hasCard(card, word))) || available[0]
  if (existing) return bindWord(existing)
  const missing = keys.filter((_, index) => !local[index])
  if (!missing.length) return bindWord()
  panel.textContent = '正在查找词条…'
  S.findWords(missing).then((words) => bindWord(missing.map((key) => words.get(key)).find(canStudy))).catch(() => {
    if (panel.isConnected) panel.textContent = '暂时无法连接词库。'
  })
}

function notifyTopic(message, root = $('#workplace-topics')) {
  if (!root) return
  let status = root.querySelector('.topic-status')
  if (!status) {
    status = document.createElement('p')
    status.className = 'tiny topic-status'
    status.setAttribute('role', 'status')
    root.appendChild(status)
  }
  status.textContent = message
}

function readAloud(text) {
  if (!speak(text)) notifyTopic('当前设备无法朗读。', $('#topic-word-actions') || undefined)
}

export function bindTopics(showWord) {
  const root = $('#workplace-topics')
  if (!root) return

  const search = $('#topic-search')
  if (search) search.oninput = () => {
    query = search.value
    $('#topic-list').innerHTML = topicList()
  }

  const topicId = selected
  root.querySelectorAll('[data-topic-section]').forEach((detail) => {
    detail.ontoggle = () => {
      const key = topicId + '/' + detail.dataset.topicSection
      if (detail.open) expandedSections.add(key)
      else expandedSections.delete(key)
    }
  })

  root.onclick = async (event) => {
    const button = event.target.closest('button')
    if (!button || !root.contains(button)) return
    const repaint = (focus) => {
      root.innerHTML = renderTopics()
      bindTopics(showWord)
      $(focus).focus()
      window.scrollTo({ top: 0 })
    }
    if (button.dataset.topicOpen) {
      selected = button.dataset.topicOpen
      repaint('#topic-title')
      return
    }
    if (button.id === 'topic-back') {
      selected = ''
      repaint('#topic-search')
      return
    }
    const topic = workplaceTopics.find((item) => item.id === selected)
    if (!topic) return
    if (button.id === 'topic-save') {
      const ids = favorites()
      if (ids.has(topic.id)) ids.delete(topic.id)
      else ids.add(topic.id)
      try {
        localStorage.setItem(favoritesKey(), JSON.stringify([...ids]))
        button.setAttribute('aria-pressed', String(ids.has(topic.id)))
        button.textContent = ids.has(topic.id) ? '已收藏' : '收藏'
      } catch (_) {
        notifyTopic('当前设备无法保存收藏。')
      }
      return
    }
    if (button.id === 'topic-report-voice') {
      readAloud(topic.report.join(' ').replace(/\[\[([^|\]]+)(?:\|[^\]]+)?\]\]/g, '$1'))
      return
    }
    const lines = [...topic.intake, ...topic.handover]
    if (button.dataset.topicVoice !== undefined) readAloud(lines[Number(button.dataset.topicVoice)][1])
    if (button.dataset.topicCopy !== undefined) {
      const copied = await copyText(lines[Number(button.dataset.topicCopy)][1])
      if (button.isConnected) {
        button.textContent = copied ? '已复制' : '未复制'
        notifyTopic(copied ? '英文已复制。' : '复制失败，可长按英文选取。', button.closest('.topic-phrase'))
      }
    }
    if (button.dataset.topicExpression) showExpression(topic.expressions[button.dataset.topicExpression], showWord)
  }
}
