# LexiLoop · 英语搭配记忆

> 个人向的英语搭配 / 表达记忆应用。针对 NYU Shanghai 公共安全岗位的工作英语语料库而建：
> FSRS 间隔重复排程、三种卡型、多种主动回忆玩法、手机与电脑进度同步。
> 线上地址：https://lexiloop-82703.app.workbuddy.host/

---

## 1. 这个项目是什么

一个**无构建的静态站点**（原生 ES Module + 一个 Python 静态服务器），数据存在云服务后端
（WorkBuddy 云服务 / genie-baas，PostgreSQL 兼容），登录用邮箱 + 密码。

设计上刻意保持「零依赖、零构建」：没有 npm install、没有 webpack/vite，
改完源码直接部署，浏览器按 URL 上的 `?v=N` 拉新版本。

### 目录结构

```text
lexiloop/                    ← 应用本体（部署这个目录）
├── index.html               入口（启动看门狗、主题预置）
├── server.py                本地静态服务器（强制 no-cache 响应头）
├── styles.css               全部样式（含深浅色主题）
├── sw.js                    Service Worker 离线壳
├── manifest.webmanifest     PWA 配置
├── icon.svg / icon-*.png    图标
├── vendor/
│   └── workbuddy-cloud-sdk.js  云服务 SDK 同源副本（不依赖外部 CDN）
└── js/
    ├── app.js               启动 / 路由 / 全局刷新
    ├── store.js             本地状态 + 云端同步 + 备份恢复
    ├── cloud.js             云服务客户端、登录、模型通道
    ├── fsrs.js              FSRS 排程算法（含自检）
    ├── views.js             所有页面视图 + 学习卡 + 交互判定
    ├── game.js              练习场：配对 / 听写 / 闯关 / AI 对话
    ├── labs.js              练习场：搭配对战 / 组句 / 语音跟读
    ├── importer.js          Markdown / 结构化文档解析
    ├── exporter.js          导出 Markdown / Word / Anki CSV / 复习记录
    ├── judge.js             作答判定（搭配匹配）
    ├── enrich.js            词条富化（模型生成搭配）
    └── ui.js                通用组件（弹层、提示、图标、朗读）

tools/                       ← 测试与运维脚本（Playwright 自动化等）
db/                          ← 数据库结构文档与迁移策略（不含数据）
├── schema.md                表结构定义
└── migrations/README.md     迁移策略

DEPENDENCIES.md              ← 依赖清单与云服务说明
.env.example                 ← 环境变量示例（无真实值）
```

---

## 2. 环境要求与安装

| 需要 | 开发用版本 | 最低要求 | 用途 |
| --- | --- | --- | --- |
| Python | 3.13.12 | 3.11 | 静态服务器、运维脚本 |
| Node.js | 22.22.2 | 20 | 仅用于语法检查与部分工具脚本 |
| 浏览器 | Edge（Chromium 内核） | Edge / Chrome 最新版 | 语音跟读依赖 Web Speech API |

**包管理器：本项目没有 npm 依赖，不需要 `npm install`，仓库里也没有 `package.json`。**
前端能力全部用浏览器原生 API 或按需 CDN 加载（见 DEPENDENCIES.md）。

```bash
# 1. 克隆仓库
git clone https://github.com/issac-js/lexiloop.git
cd lexiloop

# 2.（可选）只有跑端到端测试才需要 Python 第三方包
pip install playwright python-docx rapidocr-onnxruntime
playwright install msedge
```

---

## 3. 启动

```bash
cd lexiloop
python server.py          # 默认监听 0.0.0.0:3000
# 浏览器打开 http://127.0.0.1:3000
```

换端口用环境变量 `PORT`：

```bash
# macOS / Linux
PORT=8123 python server.py

# Windows cmd
set PORT=8123 && python server.py

# Windows PowerShell
$env:PORT='8123'; python server.py
```

> ⚠️ **本地预览登录不可用**：云服务要求请求带合法 Origin，`localhost` 会被拒。
> 本地只用来调样式和布局；要测登录与数据请用线上地址。

---

## 4. 构建

**没有构建步骤。** 改完源码即成品。唯一的发布约定是版本号：

> 每次发布前必须把所有 `from './xxx.js?v=N'` 的 N 加一（含 `index.html` 里的 `app.js`）。

原因：CDN 会按完整 URL 缓存 js 文件，连 `cache: 'no-store'` 都绕不过边缘缓存。
不加版本号，用户会拿到旧模块，产生「新代码调用旧导出」这类难查的报错。
`sw.js` 里的 `CACHE` 名（`lexiloop-shell-vN`）同步改。

一键升版本（在仓库根目录执行，把 `ver` 改成新版本号）：

```bash
python - <<'PY'
import re, pathlib
d = pathlib.Path('lexiloop'); ver = 109   # ← 改成新版本号
pat = re.compile(r"(from\s+')(\./[^']+\.js)(?:\?v=\d+)?(')")
for f in sorted((d/'js').glob('*.js')):
    s = f.read_text(encoding='utf-8')
    s2, c = pat.subn(lambda m: m.group(1)+m.group(2)+'?v='+str(ver)+m.group(3), s)
    if c: f.write_text(s2, encoding='utf-8')
idx = d/'index.html'; s = idx.read_text(encoding='utf-8')
idx.write_text(re.sub(r'(src="js/app\.js)(\?v=\d+)?(")', r'\1?v='+str(ver)+r'\3', s), encoding='utf-8')
sw = d/'sw.js'; s = sw.read_text(encoding='utf-8')
sw.write_text(re.sub(r"lexiloop-shell-v\d+", 'lexiloop-shell-v%d' % ver, s), encoding='utf-8')
print('v%d' % ver)
PY
```

> 当前代码版本：**v108**（已发布）

---

## 5. 测试

### 5.1 语法检查（无需网络，随时可跑）

```bash
# 全部 13 个 ES Module 逐个过 node --check
cd lexiloop/js
for f in *.js; do cp "$f" "/tmp/check-$f.mjs" && node --check "/tmp/check-$f.mjs" && rm "/tmp/check-$f.mjs" || echo "FAIL: $f"; done
```

### 5.2 本地冒烟（起服务后所有资源应返回 200）

```bash
cd lexiloop && python server.py &
for p in / index.html styles.css sw.js manifest.webmanifest icon.svg \
         vendor/workbuddy-cloud-sdk.js js/app.js js/store.js js/cloud.js; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000/$p")
  echo "$code $p"
done
```

### 5.3 端到端（需要 Playwright + Edge，且要联网）

```bash
cd tools
python e2e9.py            # 全维度功能验证
python e2e10.py           # leech 改写（真实 LLM）+ docx 导入
python qa-ios.py          # iOS 适配检查
```

端到端脚本里的账号是**测试账号**，不是所有者账号；测试账号数据稀疏，
某些断言（关卡数、配对组数）会因此降级，属预期。

---

## 6. 环境变量

| 变量 | 用于 | 默认 | 说明 |
| --- | --- | --- | --- |
| `PORT` | `server.py` | `3000` | 静态服务器监听端口 |

参考 `.env.example`。本应用**不需要任何密钥类环境变量**：
云服务前端配置在 `lexiloop/js/config.js`（发布键，设计上公开）；
「自带 LLM API Key」只存用户浏览器 localStorage，不进仓库、不过服务端。

---

## 7. 数据库

表结构（`words` / `cards` / `reviews` / `settings` / `daily`）见 **[db/schema.md](db/schema.md)**。
迁移策略见 **[db/migrations/README.md](db/migrations/README.md)**。

关键设计：`words` 是全局共享缓存——词条、释义、搭配只要有一个用户生成过，
所有用户都能直接复用；`cards` 才是每人一份的学习进度。

备份与迁移走应用内「我的 → 备份与迁移」：导出 JSON / 从备份恢复（只补缺不覆盖）/
导出学习记录 CSV / 导出 Anki TSV。换电脑不需要迁数据——学习进度都在云端，登录同一账号即可。

---

## 8. 部署

应用本体就是 `lexiloop/` 目录，两种方式：

1. **WorkBuddy 云服务静态托管**（现用）：把 `lexiloop/` 目录内容发布为静态应用，
   入口 `index.html`，应用类型 web。平台 CDN 按 URL 缓存，所以必须遵守 §4 的版本号约定。
2. **任意静态托管**：`lexiloop/` 丢到 Nginx / OSS / GitHub Pages 均可；
   需要动态端口时用 `python server.py` 起服务（它存在的唯一理由是绕过 CDN 边缘缓存，
   强制回源）。

---

## 9. 安全约定（提交前必读）

- **本仓库不含任何密钥**。`js/config.js` 里的 `publishableKey`（`wbpk_ 前缀`）是
  设计上公开的前端发布键，只标识应用、不含权限（服务端按 Origin 校验），可安全提交。
- **生产数据与用户数据不入库**：`.gitignore` 排除 `backup/`、`import/`、`*.sql`、
  截图与测试输出 JSON。历史迁移 SQL 因含生产内容被排除，策略见 `db/migrations/README.md`。
- 发现误提交的敏感内容：先轮换凭据，再清历史（`git filter-repo`），不要只是删文件了事。

---

## 10. 常见坑（改代码前先读）

1. **加 `?v=N`**：见 §4，最容易忘、最难查的一条。
2. **`dataset` 取出来一定是字符串**：`x.id === el.dataset.id` 在 id 是数字时永远为 false，
   表现为「点击毫无反应且无报错」。用 `String(x.id) === String(el.dataset.id)`。
3. **渲染函数有「终态」时，绑定函数必须同步守卫**：结束态下 `arr[i]` 越界为 undefined，
   在绑定阶段抛错会导致**后面的按钮全部没绑上**，而页面视觉完全正常。
4. **判定两侧必须用同一套分词**：连字符、所有格、占位符（sb/sth）任一侧处理不一致，
   都会让正确搭配被误判为脱靶。
5. **云端模型限流是按模型的**：`deepseek-v4-flash` 被限流时，其它模型仍可用。
   应用已内置退避重试 + 自动换模型（顺序见 `js/cloud.js:PREFERRED_MODELS`）。
6. **本地预览不能登录**：Origin 校验会拒 localhost。
7. **测试脚本里数字键 1（忘了）会把卡重新排回队尾**：自动化测试想清空队列要用 2/3/4，
   否则永远打不完。
8. **进度环这类「完成度」的分母要用今日实际工作量**（已完成 + 还剩），
   而不是 `daily_max_review` 这类上限配置——否则词库小时环永远空着，激励意义归零。

---

## 11. 从 GitHub 拉取更新并重新部署

```bash
# 1. 拉取远端更新（保留本地未提交改动）
git pull --ff-only origin main

# 2. 有冲突时：本地工作副本是部署真源，先提交或 stash 再合
git status

# 3. 按 §4 升版本号（改了什么都要升，哪怕只改一行 CSS）
python - <<'PY'
import re, pathlib
d = pathlib.Path('lexiloop'); ver = 109
pat = re.compile(r"(from\s+')(\./[^']+\.js)(?:\?v=\d+)?(')")
for f in sorted((d/'js').glob('*.js')):
    s = f.read_text(encoding='utf-8')
    s2, c = pat.subn(lambda m: m.group(1)+m.group(2)+'?v='+str(ver)+m.group(3), s)
    if c: f.write_text(s2, encoding='utf-8')
idx = d/'index.html'; s = idx.read_text(encoding='utf-8')
idx.write_text(re.sub(r'(src="js/app\.js)(\?v=\d+)?(")', r'\1?v='+str(ver)+r'\3', s), encoding='utf-8')
sw = d/'sw.js'; s = sw.read_text(encoding='utf-8')
sw.write_text(re.sub(r"lexiloop-shell-v\d+", 'lexiloop-shell-v%d' % ver, s), encoding='utf-8')
print('v%d' % ver)
PY

# 4. 提交并推送
git add -A && git commit -m "release: v109"
git push origin main

# 5. 重新部署：把 lexiloop/ 目录重新发布到云托管（或 rsync 到自有静态服务器），
#    然后硬刷新一次线上页面确认新版本号生效
```

---

## 12. 许可与边界

个人自用项目。语料来自个人工作积累；释义与搭配由模型生成，**仅供学习参考，请以权威词典为准**。
