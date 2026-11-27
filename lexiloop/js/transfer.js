/** Small, curated structure → retrieval → new-context pilot. No model or FSRS writes. */
import * as S from './store.js?v=136'
import { $, esc } from './ui.js?v=136'
import { normalizeAns } from './judge.js?v=136'

// Original examples; references explain meaning, not an exhaustive list of valid answers.
export const GROUPS = [
  { id:'problem', title:'解决问题：过程与结果',
    structure:'发现问题 → 逐步处理 → 得到解决结果',
    contrast:'work through a problem 强调逐步处理；resolve a problem 强调解决结果。具体语境中可以都成立，不要求互相替换。',
    examples:['We can work through the details together.', 'The technician resolved the connection problem.'],
    sentence:'The team managed to ________ the access problem before the event.',
    zh:'团队成功在活动前解决了出入问题。', target:'resolve', accept:['solve','work through','sort out','fix'],
    transfer:'换成团队还在逐步处理、尚未宣布解决结果，你会怎样说？',
    reference:'The team is working through the access problem.', source:'work-through' },
  { id:'contact', title:'联系：建立联系与保持联系',
    structure:'首次联系 → 沟通需求 → 后续保持联系',
    contrast:'get in touch with 表示取得联系；keep in touch with 表示保持联系。两者的时间侧重点不同。',
    examples:['Please get in touch with the reception team.', 'We will keep in touch during the project.'],
    sentence:'Please ________ the coordinator to ask where the meeting is.',
    zh:'请联系协调员，询问会议地点。', target:'get in touch with', accept:['contact','reach out to'],
    transfer:'换成项目结束后仍保持联系，你会怎样表达？',
    reference:'We will keep in touch after the project ends.', source:'touch' },
  { id:'followup', title:'跟进：已有事项的下一步',
    structure:'已有报告 → 跟进处理 → 告知进展',
    contrast:'follow up on a report 是在已有报告后继续采取行动；submit a report 是提交报告。不要将“跟进”理解为首次提交。',
    examples:['I will follow up on your request tomorrow.', 'Please submit a report after the meeting.'],
    sentence:'We will ________ your request tomorrow and send you an update.',
    zh:'我们明天会跟进你的请求并告知进展。', target:'follow up on', accept:['follow up','look into'],
    transfer:'换成已经跟进并拿到新进展，向对方写一句通知。',
    reference:'We followed up on your request and have an update for you.', source:'follow-up' },
  { id:'clarify', title:'澄清：信息不清楚时先问清',
    structure:'发现含糊信息 → 请求澄清 → 确认理解',
    contrast:'clarify the instructions 是让指示更清楚；confirm the details 是核实或确认细节。澄清和确认常先后发生。',
    examples:['Could you clarify the instructions?', 'Let me confirm the room number.'],
    sentence:'Could you ________ what you mean by temporary access?',
    zh:'你能澄清一下“临时通行”是什么意思吗？', target:'clarify', accept:['explain'],
    transfer:'问清含义后，写一句确认你理解的有效期。',
    reference:'Let me confirm: the pass is valid until Friday.', source:'clarify' },
  { id:'verify', title:'核实：先查证再确认',
    structure:'收到信息 → 查证依据 → 确认事实',
    contrast:'verify information 强调查证其真实性；confirm information 可指核实后的确认，也可指告知确认结果。不能只凭猜测宣布已核实。',
    examples:['We need to verify the information first.', 'I can confirm that the room is available.'],
    sentence:'Please ________ the room number against the booking record.',
    zh:'请对照预订记录核实房间号。', target:'verify', accept:['check','confirm'],
    transfer:'如果还没拿到记录，怎样说明仍待核实而不承诺结果？',
    reference:'I still need to verify the room number.', source:'verify' },
  { id:'report', title:'报告：事件与接收方',
    structure:'观察事件 → 报告给负责方 → 记录已知事实',
    contrast:'report an incident to someone 是向某人报告事件；record the details 是记录细节。只记录不等于已经通报。',
    examples:['Please report the incident to the supervisor.', 'Record the time and location.'],
    sentence:'Please ________ the incident to your supervisor.',
    zh:'请向主管报告该事件。', target:'report', accept:['describe'],
    transfer:'另外补一句记录事件发生时间的指引。',
    reference:'Please record the time of the incident.', source:'report' },
  { id:'refer', title:'转介：把需求交给合适的人',
    structure:'了解需求 → 找到负责方 → 转介并说明下一步',
    contrast:'refer someone to a service 是引导或转介某人到相应服务；transfer a call 是转接电话，动作对象不同。',
    examples:['We can refer you to the support team.', 'I will transfer your call to reception.'],
    sentence:'I can ________ you to the student support team.',
    zh:'我可以把你转介到学生支持团队。', target:'refer', accept:['direct'],
    transfer:'如果需要转接来电，而不是转介人员，怎样说？',
    reference:'I can transfer your call to the student support team.', source:'refer',
    relatedAnswers: { introduce:'这句话语法成立。introduce you to the team 是介绍你认识团队；refer you to the team 强调转介给团队求助。这里练习的是后者。' } },
  { id:'restrict', title:'限制：范围与权限',
    structure:'明确风险或规则 → 说明限制范围 → 提供合规下一步',
    contrast:'restrict access to a building 是限制楼宇出入；deny access 是拒绝通行。限制不一定意味着对所有人全面拒绝。',
    examples:['Access is restricted to authorized staff.', 'Visitors can ask reception for assistance.'],
    sentence:'Access to this room is ________ to authorized staff.',
    zh:'此房间仅限获授权员工进入。', target:'restricted', accept:['limited'],
    transfer:'为没有权限的访客补一句礼貌的下一步指引。',
    reference:'Please ask reception about visitor access.', source:'restrict' },
  { id:'closure', title:'关闭：停运与暂缓',
    structure:'说明状态变化 → 说明持续范围 → 明确后续安排',
    contrast:'shut down 和 shutter 都可用于业务停运；shutter 也可以是暂时关闭。suspend an activity 强调暂停，是否永久取决于语境。',
    examples:['The company shut down the branch.', 'The plant was temporarily shuttered for repairs.'],
    sentence:'The owner decided to ________ the shop permanently.',
    zh:'店主决定永久关闭商店。', target:'shut down', accept:['close','close down','shutter'],
    transfer:'换成营业暂停一周，不要暗示永久停业，你会怎样说？',
    reference:'The shop will be closed for one week.', source:'shutter' },
  { id:'resume', title:'恢复：暂停后的继续',
    structure:'暂停 → 条件满足 → 恢复进行',
    contrast:'resume an activity 表示中断后恢复进行；start an activity 可以是首次开始。恢复前先说明条件是否已满足。',
    examples:['The meeting will resume after the break.', 'We will start the orientation at nine.'],
    sentence:'The meeting will ________ after the break.',
    zh:'会议将在休息后继续进行。', target:'resume', accept:['continue','restart'],
    transfer:'如果安全检查还没结束，怎样说明恢复时间未确定？',
    reference:'We will confirm when the meeting can resume.', source:'resume' },
]

let active = null
export function resetTransfer() { active = null }
export function transferPlan(date = S.todayKey()) {
  // UTC date-number rotation; deterministic across devices/time zones for supplied study date.
  const day = Math.floor(Date.parse(date + 'T12:00:00Z') / 86400000)
  const start = Number.isFinite(day) ? ((day * 3) % GROUPS.length + GROUPS.length) % GROUPS.length : 0
  return [0,1,2].map(n => GROUPS[(start + n) % GROUPS.length])
}
export function checkTransfer(group, given) {
  const text = normalizeAns(given)
  if (!text) return 'empty'
  if (text === normalizeAns(group.target)) return 'hit'
  if (group.accept.some(x => text === normalizeAns(x))) return 'alt'
  if (group.relatedAnswers && Object.hasOwn(group.relatedAnswers, text)) return 'distinction'
  // This is a curated reference list, not an exhaustive language judge.
  return 'unreviewed'
}
export function startTransfer() {
  active = { owner:S.state.user && S.state.user.id, plan:transferPlan(), index:0,
    hint:false, result:null, given:'', results:[], done:false, saved:null }
}
function shell(body) {
  return '<h1 class="page">表达联系与新情境<span class="sub">小批试练 · 每次 3 题</span></h1>' +
    '<p class="tiny">先尝试回忆，再看提示和对照。可替代一次其他练习；不增加每日任务，不修改 FSRS，不调用 AI。</p>' +
    body + '<button class="btn block" id="transfer-home" style="margin-top:12px;">返回练习场</button>'
}
export function renderTransfer() {
  const s = active
  if (!s || s.owner !== (S.state.user && S.state.user.id)) return shell('<p>训练已结束，请返回后重新开始。</p>')
  if (s.done) return shell('<div class="card"><h2>本轮练习完成</h2><p>换个场景能否说出来，比照抄例句更值得观察。</p>' +
    '<p class="tiny">本轮：独立写出已收录表达 ' + s.results.filter(r => !r.hinted && ['hit','alt'].includes(r.verdict)).length +
    ' / 3；其他表达可自行对照，不记为错误。此结果不能单独证明已掌握。</p>' +
    '<p class="tiny">' + (s.saved ? '简要结果已保存在本机，按账号隔离；不跨设备同步。' : '本机结果未保存，学习进度不受影响。') + '</p></div>')
  const g = s.plan[s.index]
  const structure = '<p><b>关系顺序：</b>' + esc(g.structure) + '</p><p>' + esc(g.contrast) + '</p>' +
    g.examples.map(x => '<p class="tiny">' + esc(x) + '</p>').join('') +
    '<a class="tiny" target="_blank" rel="noopener noreferrer" href="https://dictionary.cambridge.org/dictionary/english/' + g.source + '">核对词义来源 · Cambridge Dictionary</a>'
  return shell('<div class="card"><div class="card-head"><h2>' + esc(g.title) + '</h2><span>' + (s.index+1) + ' / 3</span></div>' +
    '<p style="font-size:20px;overflow-wrap:anywhere;">' + esc(g.sentence) + '</p><p class="muted">' + esc(g.zh) + '</p>' +
    (!s.result ? '<label class="label" for="transfer-answer">填写空缺（允许合理替代表达）</label>' +
      '<input class="input" id="transfer-answer" maxlength="160" autocomplete="off" value="' + esc(s.given) + '">' +
      '<div class="row" style="gap:8px;flex-wrap:wrap;margin-top:12px;"><button class="btn primary" id="transfer-check">核对表达</button>' +
      '<button class="btn" id="transfer-hint">先看知识联系</button><button class="btn" id="transfer-reveal">先看参考</button></div>' :
      '<div class="verdict ' + (['hit','alt'].includes(s.result)?'good':'unsure') + '">' +
      (s.result === 'hit' ? '这个表达成立。' : s.result === 'alt' ? '你的表达也成立，不必照抄参考。' : s.result === 'distinction' ? '表达成立，用意有区别。' : '先对照参考：未收录的表达不等于错误。') +
      (s.result === 'distinction' ? '<p>' + esc(g.relatedAnswers[normalizeAns(s.given)]) + '</p>' :
        s.result === 'unreviewed' ? '<p>这里采用离线参考表，尚未判断这条作答。可先比较：' + esc(g.contrast) + '</p>' : '') +
      '<p>你写的：' + esc(s.given || '本次先看参考') + '<br>参考填法：<b>' + esc(g.target) + '</b></p></div>' +
      '<details><summary style="min-height:44px;cursor:pointer;">查看表达联系与例句</summary>' + structure + '</details>' +
      '<h3>再换一个情境（可选）</h3><p>' + esc(g.transfer) + '</p>' +
      '<textarea class="input" id="transfer-reflection" rows="2" maxlength="600" placeholder="尝试说出来或写一句；不自动评分，也不保存原文"></textarea>' +
      '<details><summary style="min-height:44px;cursor:pointer;">查看一种表达方式</summary><p>' + esc(g.reference) + '</p></details>' +
      '<button class="btn primary block" id="transfer-next" style="margin-top:12px;">' + (s.index === 2 ? '完成本轮' : '下一题') + '</button>') +
    (s.hint && !s.result ? '<div style="margin-top:16px;">' + structure + '</div>' : '') + '</div>')
}
export function bindTransfer(cb, back) {
  const home = $('#transfer-home'); if (home) home.onclick = () => { resetTransfer(); back() }
  const s = active
  if (!s || s.done || s.owner !== (S.state.user && S.state.user.id)) return
  const input = $('#transfer-answer')
  if (input) input.oninput = () => { s.given = input.value }
  const check = $('#transfer-check'); if (check) check.onclick = () => { s.result = checkTransfer(s.plan[s.index], s.given); cb() }
  const hint = $('#transfer-hint'); if (hint) hint.onclick = () => { s.hint = true; cb() }
  const reveal = $('#transfer-reveal'); if (reveal) reveal.onclick = () => { s.hint = true; s.result = 'revealed'; cb() }
  const next = $('#transfer-next'); if (next) next.onclick = () => {
    if (!s.result || s.done || s.owner !== (S.state.user && S.state.user.id)) return
    s.results.push({ group:s.plan[s.index].id, verdict:s.result, hinted:s.hint })
    s.index++; s.given = ''; s.hint = false; s.result = null
    if (s.index === s.plan.length) {
      s.done = true
      try {
        if (!s.owner) throw new Error('No account')
        const key = 'lexiloop.transfer.v1.' + encodeURIComponent(String(s.owner))
        let rows = JSON.parse(localStorage.getItem(key) || '[]')
        if (!Array.isArray(rows)) rows = []
        rows = rows.filter(x => x && Number.isFinite(x.at) && Array.isArray(x.results))
        rows.push({ at:Date.now(), date:S.todayKey(), results:s.results })
        localStorage.setItem(key, JSON.stringify(rows.slice(-60))); s.saved = true
      } catch (_) { s.saved = false }
    }
    cb()
  }
}
