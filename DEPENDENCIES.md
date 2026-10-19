# 依赖清单

> 生成日期：2026-09-27　｜　本次更新：2026-10-19，对应代码版本：v108
> 原则：**前端零 npm 依赖**。所有能力要么用浏览器原生 API，要么从 CDN 按需拉取。

---

## 1. 开发与运行环境

| 组件 | 开发用版本 | 最低要求 | 用途 |
| --- | --- | --- | --- |
| Python | 3.13.12 | 3.11 | 静态服务器、测试与运维脚本 |
| Node.js | 22.22.2 | 20 | 离线检查（`python -B tools/ci_check.py`） |
| 浏览器 | Microsoft Edge（Chromium 内核） | Edge / Chrome 最新版 | 语音跟读需 Web Speech API |

**Python 第三方包**（仅测试脚本用，应用本体不需要）：

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `playwright` | ≥1.40 | 端到端自动化测试 |
| `python-docx` | ≥1.0 | 生成测试用 .docx |
| `rapidocr-onnxruntime` | ≥1.3 | 本地 OCR（读取截图，非应用功能） |

安装：

```bash
pip install playwright python-docx rapidocr-onnxruntime
playwright install msedge
```

---

## 2. 前端运行时依赖

### 2.1 完全零依赖的部分

应用的核心功能**不依赖任何第三方库**：

| 能力 | 实现方式 |
| --- | --- |
| 模块系统 | 浏览器原生 ES Module |
| 网络请求 | 原生 `fetch` |
| 状态与离线 | 原生 `localStorage` |
| 图表（遗忘曲线、热力图、占比条） | 手写内联 SVG |
| 朗读 | 原生 `SpeechSynthesis` |
| 语音跟读 | 原生 `SpeechRecognition`（`webkitSpeechRecognition`） |
| 文件读取 | 原生 `FileReader` |
| CSV 解析 | 自己实现的引号感知解析器 |
| FSRS 排程 | `js/fsrs.js`，纯函数自实现（含自检） |

### 2.2 CDN 按需加载（只在触发对应功能时才拉取）

| 库 | 版本 | CDN 地址 | 触发时机 |
| --- | --- | --- | --- |
| `docx` | 8.5.0 | `https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js` | 点击「导出 Word」 |
| `mammoth` | 1.8.0 | `https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js` | 导入 `.docx` 文件 |

> 两个库都做了**优雅降级**：CDN 拉不到时给出明确提示（导出 Word 降级为 .doc 的 HTML，
> 导入 docx 提示检查网络），不会白屏或静默失败。

### 2.3 云服务 SDK（同源内置）

| SDK | 说明 |
| --- | --- |
| `@tencent-ai/workbuddy-cloud-sdk` | 以**同源副本**随应用发布：`lexiloop/vendor/workbuddy-cloud-sdk.js`，不依赖外部 CDN；`index.html` 里保留一行 CDN 兜底（vendor 文件缺失时同步补上） |

> 为什么内置而不用 CDN：实测 cdn.jsdelivr.net 在本机会被间歇性重置，SDK 加载失败时
> 认证、数据同步、云端 AI 三条链路会**静默失效**——页面照常打开、控制台零异常。
> 内置同源后：不依赖外部 CDN、能被 Service Worker 缓存、离线也能起。

---

## 3. 云服务后端

| 项 | 值 |
| --- | --- |
| applicationId | `wbapp_3mGfJgXC5sdFj1a25a9NhF`（新）／`wbapp_1an3izHncW5fGibWvJj8Cg`（旧站） |
| 类型 | 静态站点托管 + 云数据库（PostgreSQL 兼容） |
| 认证 | 邮箱 + 密码 |

### 3.1 数据表

表结构（字段、唯一键、`payload` 结构）详见 **[db/schema.md](db/schema.md)**。
一句话版本：`words`（全局共享词库）/ `cards`（个人卡片与 FSRS 状态）/
`reviews`（复习日志）/ `settings`（个人设置）/ `daily`（每日统计）。

### 3.2 `payload` 结构（词条内容）

完整结构与字段语义见 **[db/schema.md](db/schema.md)** §3（同一份内容，不在此重复维护）。

---

## 4. 模型通道

| 通道 | 说明 |
| --- | --- |
| **云端免密钥**（默认） | 由平台提供，无需 API Key；模型列表约 30 个，前端可切换 |
| **自带 API**（可选） | 支持任何 OpenAI 兼容接口；配置只存在**本机浏览器 localStorage**（键名 `lexiloop.customapi.v1`），不上云 |

默认模型选择顺序（`js/cloud.js:PREFERRED_MODELS`）：

1. `deepseek-v4-flash` —— 实测稳定、便宜
2. `hunyuan-chat`
3. `deepseek-v4.1-flash` —— 最快，但**会被单独限流**，故降为备选
4. `deepseek-v4-pro`

> 实测（2026-09-27）：`deepseek-v4.1-flash` 被限流时，其余模型全部正常 —— **限流是按模型的**。
> 应用已内置指数退避重试 + 连续被限流自动换模型。

---

## 5. 定时任务

| 名称 | 计划 | 作用 |
| --- | --- | --- |
| LexiLoop 每日一词 | 每天 07:30 | 从词库挑一个最该复习的词，输出中英对照卡片 |

---

## 6. 版本与缓存约定

- 所有 `from './xxx.js?v=N'` 的 N 必须**同步递增**（含 `index.html` 里的 `app.js`，以及 `sw.js` 的 `CACHE` 名）。
- 原因：CDN 按完整 URL 缓存，`cache: 'no-store'` 也绕不过边缘缓存。
- 当前版本：**v108**（13 个 JS 模块）


## 7. 云端检查与发布边界

默认 CI 只需 Python 3.12 + Node 22，不安装 Playwright，不运行历史在线脚本。
历史工具另有浏览器、第三方 Python 包、Windows 路径及测试数据要求；执行前逐一核对。
部署只使用 `tools/release_bundle.py` 生成的白名单静态资源包；详见
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。
