/**
 * config.js — 云服务公开配置
 *
 * 这两个值来自应用开通云服务时返回的 publicConfig，只包含「是哪个应用」的信息，
 * 不含任何权限（服务端按 Origin 精确校验），因此可以安全地放在前端代码里。
 * 切勿在此处或任何前端文件中写入任何长期密钥。
 */
export const CLOUD_CONFIG = {
  endpoint: 'https://lexiloop-82703.app.workbuddy.host',
  publishableKey: 'wbpk_3mGfJgXC5sdFj1a25a9NhF_ZGLzQc1XNhZJRFu0xNZSXKxanMGgSdgX',
}

/** 本地缓存键 */
export const LS_KEYS = {
  state: 'lexiloop.state.v2',
  lastSync: 'lexiloop.lastsync.v2',
}

/** 卡片类型定义 */
export const CARD_TYPES = {
  recognition: {
    key: 'recognition',
    label: '英→中',
    desc: '看英文，回忆释义与搭配',
  },
  cloze: {
    key: 'cloze',
    label: '例句填空',
    desc: '例句挖空，填出搭配',
  },
  production: {
    key: 'production',
    label: '中→英',
    desc: '看中文，主动说出英文表达',
  },
}

/** 推荐节奏（Kevin 2026-09-29 定稿）：一键还原用，也是新装设备的默认值。
 *  改这里就等于改"推荐值"，设置页的「用推荐设置」按钮直接读这个对象。 */
export const RECOMMENDED_SETTINGS = {
  daily_new: 8,               // 每日新学词数
  daily_max_review: 300,      // 每日复习上限
  target_retention: 0.9,      // 目标留存率 90%
  learn_step_minutes: 10,     // 新卡巩固间隔（分钟）
  learn_step_days: 1,         // 新卡次日间隔（天）
  queue_interleave: 4,        // 交错比例
  goal_include_test: true,    // 达标需含每周抽测
  rest_weekday: 0,            // 周日休息日
  auto_credit: true,          // 练习/抽测结束自动写入复习计划
}

export const DEFAULT_SETTINGS = {
  daily_new: 8,              // 稳比快重要：3030 词存量，8/天 ≈ 380 天走完，日均 15-20 分钟
  daily_max_review: 300,     // 复习上限放宽，到期多时不至于卡住队列
  target_retention: 0.9,
  card_types: ['recognition'],
  deck: '默认词单',
  llm_model: null,
  learn_step_minutes: 10,
  learn_step_days: 1,
  queue_interleave: 4,
  goal_include_test: true,   // 达标需含每周抽测：没有跨日检索数据，达标就退化成机械打卡
  rest_weekday: 0,           // 周日休息日：只复习不引新词，留一天做整合与抽测
  auto_credit: true,         // 练习/抽测结束自动写入复习计划（按用时分档 4/3/2/1）
  last_backup_at: null,      // 上次导出 JSON 备份的时间戳（null = 从未备份）
  backup_snooze_until: 0,    // 告警卡"7 天后再提醒"的到期时间，两个字段都随 extra 同步到云端
  test_mode: 'mixed',        // 每周抽测题型：mixed（6 选择 + 4 产出，推荐）/ choice / write
}

/** 一次并发处理多少个词条（云端为推理型模型，并发能显著缩短总耗时） */
export const ENRICH_CONCURRENCY = 3
