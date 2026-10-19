# 数据库结构

> 本文档描述 LexiLoop 云数据库的表结构。结构信息从 `lexiloop/js/store.js`、
> `lexiloop/js/cloud.js` 的实际用法整理（2026-10-19，对应代码版本 v108）。
> **本文档只含结构，不含任何数据**——生产库内容与用户数据按仓库安全约定一律不入库。

## 0. 基本信息

| 项 | 值 |
| --- | --- |
| 平台 | WorkBuddy 云服务（genie-baas），PostgreSQL 兼容 |
| applicationId | `wbapp_3mGfJgXC5sdFj1a25a9NhF` |
| 认证 | 邮箱 + 密码（服务端按 Origin 校验前端发布键） |
| 访问方式 | 前端经同源 SDK（`lexiloop/vendor/workbuddy-cloud-sdk.js`）以登录用户身份读写，全部走行级权限，无服务端直连口令 |

## 1. 表清单

| 表 | 作用 | 行归属 |
| --- | --- | --- |
| `words` | **全局共享**词库：词条、释义、搭配、例句 | 所有用户共用一份 |
| `cards` | 每人一份的学习卡片与 FSRS 排程状态 | 按 `owner_id` 隔离 |
| `reviews` | 复习日志（每次评分一条） | 按 `owner_id` 隔离 |
| `settings` | 用户设置（每日新词、复习上限、目标留存率等） | 按 `owner_id` 隔离 |
| `daily` | 每日统计（复习量、正确率、分钟数） | 按 `owner_id` 隔离 |

## 2. 字段定义

### 2.1 `words`（全局共享）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | 主键 | 自增 |
| `normalized` | text，唯一 | 词条的规范化形式（小写、去标点），导入与查重依据 |
| `payload` | jsonb | 词条全部内容，结构见 §3 |
| `prompt_version` | text | 生成内容所用的提示词版本 |
| `confidence` | float | 模型自评置信度 |
| `verification_status` | text | 人工复核状态：`reviewed` / `flagged` 等 |
| `verified_at` | timestamptz | 复核时间 |
| `verify_note` | text | 复核意见 |
| `created_at` / `updated_at` | timestamptz | 时间戳 |

### 2.2 `cards`（个人）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | 主键 | 自增 |
| `owner_id` | text | 归属用户（云端账号 ID） |
| `word_id` | 外键 → `words.id` | 对应词条 |
| `deck` | text | 所属词单（如「默认词单」） |
| `card_type` | text | 卡型：`recognition`（英→中）/ `cloze`（例句填空）/ `production`（中→英） |
| `batch` | text | 导入批次号 |
| `status` | text | `new` / `learning` / `review` / `relearning` |
| `due` | timestamptz | 下次到期时间 |
| `stability` | float | FSRS 稳定性 |
| `difficulty` | float | FSRS 难度 |
| `reps` | int | 复习次数 |
| `lapses` | int | 遗忘次数 |

唯一键：`(owner_id, word_id, card_type)`。

### 2.3 `reviews`（个人）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | 主键 | 自增 |
| `owner_id` | text | 归属用户 |
| `card_id` | 外键 → `cards.id` | 对应卡片 |
| `grade` | int | 评分（1-4） |
| `elapsed_ms` | int | 作答耗时（毫秒） |
| `created_at` | timestamptz | 复习时间 |

### 2.4 `settings`（个人）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `owner_id` | text，唯一 | 归属用户 |
| `daily_new` | int | 每日新学词数 |
| `daily_max_review` | int | 每日复习上限 |
| `target_retention` | float | 目标留存率 |
| `extra` | jsonb | 其余设置（卡型、词单、模型、休息日、备份提醒等） |

### 2.5 `daily`（个人）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `owner_id` | text | 归属用户 |
| `reviewed_on` | date | 统计日期 |
| `total` | int | 当日复习总次数 |
| `correct` | int | 一次通过次数 |
| `minutes` | int | 当日学习分钟数 |

## 3. `words.payload` 结构（词条内容）

```jsonc
{
  "lemma": "commit",
  "senses": [{ "pos": "v.", "def_en": "", "def_zh": "承诺/致力于（某事或做某事）" }],
  "collocations": [{
    "pattern": "commit resources to (something)",
    "type": "verb+noun",
    "strength": "medium",
    "register": "formal",
    "zh": "投入/调配资源（用于某事）",
    "examples": [{ "en": "The office will commit resources to safety training.", "zh": "…" }]
  }],
  "confusables": [{ "word": "...", "note": "..." }],
  "word_family": ["commitment"],
  "mnemonic": "...",
  "confidence": 0.9,
  "prompt_version": "doc-v1 | v2",
  "topic": "Campus Operations：最值得先背的工作英语",
  "source_examples": [{ "en": "...", "zh": "..." }],
  "enrich_attempted": true,
  "leech_rewritten": true
}
```

字段语义：

- `prompt_version: "doc-v1"` —— 释义来自用户自己的文档（非模型生成）。
- `topic` —— 来自文档章节，是「情景闯关」关卡与「掌握度地图」的分组依据。
- `enrich_attempted: true` —— 已判定生成不出搭配（如 `X vs. Y` 对比类），不再重试。
- `leech_rewritten: true` —— 该词用过「AI 帮我改短」。

## 4. 关键设计

**`words` 是全局共享缓存**：词条、释义、搭配只要有一个用户生成过，所有用户都能直接复用，不必重复付费调用模型。`cards` / `reviews` / `settings` / `daily` 才是每人一份的学习进度。
