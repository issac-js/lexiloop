# LexiLoop 检查与发布

## 当前状态

GitHub 自动离线检查和发布包已配置并已在 GitHub Actions 成功运行。
根据用户于 2026-10-19 转回的原 WorkBuddy 项目核查报告，当前项目只能在 WorkBuddy
会话内使用 `workbuddy_sites_deploy` 更新发布，并要求用户在发布当轮明确说“发布”。
该报告称未提供 GitHub 自动部署、外部发布 API/CLI 或部署 webhook；本仓库维护端
未直接检查其本机工具或技能，不把这项报告泛化为所有 WorkBuddy 版本的永久结论。
当前采用 GitHub 自动检查与打包、WorkBuddy 手动授权发布的流程。
没有自动部署 job，也不会迁移数据库。
现有正式站点：<https://lexiloop-82703.app.workbuddy.host/>。

## 检查和固定发布来源

1. 在独立分支修复应用并用 `tools/bump_version.py` 更新版本。
2. 提交 PR，确认 `LexiLoop checks and release bundle` 的 `check`、`browser`、`ios-safari` 对同一最终提交全部成功。后两项为隔离夹具浏览器和 Simulator 测试，边界见 [浏览器复测说明](../tools/README-browser-checks.md)。
3. 审核后合并到 main；等待 main 的检查成功。
4. 从该次 main 检查下载 `lexiloop-FULL_SHA` artifact，保存 ZIP 和 SHA-256 文件。
5. WorkBuddy 先读取并核对发布说明，准备 ZIP 中的文件，保留原应用绑定配置。
   收到用户在当轮明确的“发布”指令后，使用原 `lexiloop/` 对应的应用目录更新现有应用；
   不另建临时应用，不以其他目录猜测目标。ZIP 解压后不再套 lexiloop 子目录。
   发布资源中不含 server.py、tools、报告、环境文件或仓库根目录。
6. 保留上一份已验收的 ZIP、摘要和 SHA，以便静态代码回滚。

GitHub PR 的发布包标记 PR 源提交，合并后的发布包标记 main 提交；实际部署 main 的包。
私有仓库的 Actions 执行额度和 artifact 保留期受账户设置影响；本工作流保留产物 14 天，
长期回滚包需由部署端另行保存。新增公开静态资源时需更新 `PUBLIC_FILES` 白名单。

## 本地复现

在准备发布的干净 checkout 中运行（Python 3.12、Node 22；无需 npm/pip 安装）：

```bash
python -B tools/ci_check.py
python -B tools/check_line_endings.py
python -B tools/release_bundle.py --sha FULL_SHA
```

FULL_SHA 必须是这个 checkout 的完整提交 SHA，不可随意填写。打包命令仅校验
SHA 格式，不证明工作区未修改；自动 CI 以固定 SHA checkout 保证来源对应。
ZIP 内的 release.json 记录 source_sha、app_version 和 22 个公开资源的 SHA-256。
它是版本标记，不是数字签名；不要把发布包放入 Git。

### Windows 换行与来源一致性

仓库 `.gitattributes` 固定文本文件 LF，二进制保持原始字节。
`check_line_endings.py` 检查 Git 索引和工作区中的 CRLF/mixed，不自动改文件；
该检查要求完整 Git checkout，不能在无 .git 的导出目录中运行。
Git 的换行规则不会自动修复已存在的工作区文件。检查失败时先确认文件和差异，
在独立分支中处理，不能对含生产数据的工作目录盲目执行全仓重写。
正式上线优先使用 CI 产物；本地重建即使逻辑相同，也必须与提交 blob 字节一致后才能部署。

## 上线验收

```bash
python -B tools/verify_deployed.py \
  --url https://lexiloop-82703.app.workbuddy.host/ \
  --sha FULL_SHA
```

该命令只做 HTTPS GET，核对 release.json 和全部资源，不登录、不写云库。
再使用隔离测试账号验证登录、学习页、同步和模型通道。测试不能以删除或改写
现有用户数据作为清理方式。页面打开和资源一致不代表云端权限、AI 或学习流程已通过。
首次部署前线上没有 release.json，因此命令应失败；不能把失败写成验收成功。

资源校验只能证明检查时最终部署内容一致，不能证明发布过程的多文件原子切换。
带查询参数请求成功也不能证明所有用户缓存已刷新。SW 新旧壳交接需要独立实机验证，
未测试时应标记待验证，不能写“功能风险为零”。首次发布证据与未测项见
[2026-10-19 v108 发布记录](releases/2026-10-19-v108.md)。

WorkBuddy 原始验收脚本已从提交 `8267ce11ba6b6c55d0f8a24d56f8f0195032f2d3`
导入并修正。使用方法及权限边界见 [线上验收工具说明](../tools/README-live-checks.md)：

```bash
node tools/qa-release-live.js
node tools/qa-words-read-live.js
node tools/qa-release-shot.js
```

运行前必须配置专用 QA profile、既有隔离账号邮箱、浏览器路径和期望 SHA/版本。
默认不发送验证码、不注册账号、不执行模型调用；仅在明确允许时使用已有账号密码登录。
模型检查另行显式开启，可能消耗额度。脚本在导航前拦截意外写请求，检测到即失败；
不以“只读”概括登录、模型和本机截图的副作用。该防护与真实浏览器流程仍需现场复测。
2026-10-20 的现场复测确认旧防护与 v108 启动链不兼容。修正版将精确无参数的
study_stats 调用转为 GET，并在浏览器本地以明确错误响应抑制 day_plan 设置写入，
后者必须记为 skip/partial，不能算持久化通过。服务器不支持 GET RPC 时仍失败，
不得自动放行 POST；详细边界和复测要求见上面的工具说明。
原 WorkBuddy 项目已回传 fef2a11 的现场复测：三工具 partial、exit 0、0 fail，
统计 GET 返回 200，设置写入本地抑制；见
[2026-10-20 现场复测记录](releases/2026-10-20-live-qa.md)。
该证据仅覆盖受防护的读取/渲染；持久化等 skip 不计通过。
CI 仅运行 `node --test tools/live-checks.test.js` 的离线模拟，不跑生产验收。
结果分为 pass / partial / fail，skip 不计通过；退出码 1/2 表示失败/配置错误。

## 回滚

如静态资源验收或功能验收失败，在原应用重新发布上一份验收成功的 ZIP，
以其 FULL_SHA 重跑资源校验，再人工确认浏览器缓存更新和登录状态。
WorkBuddy 的发布缓存刷新与多文件原子性需要先验证；若平台不能保证整体切换，
必须记录短暂混用资源风险。Service Worker 可能需要用户点“检查更新”后才接管。
静态代码回滚不回滚数据库，本流程禁止执行数据库写入和结构迁移。

首次发布前保存的旧站点快照可能没有 release.json 或来源 SHA。恢复这种快照后，
应与其保存的原始资源清单逐项核对，而不能宣称通过要求 release.json 的
`verify_deployed.py`。常规带提交标记的发布包按上面的完整 SHA 验证。

## WorkBuddy 读取私有仓库

匿名网页返回 404 不能判断仓库不存在。没有 gh CLI 登录态也不能判断 Git 未授权：
Git Credential Manager、gh、GitHub 连接器与浏览器各有自己的访问路径。
先在之前成功同步的同一 Windows 用户和原项目环境验证 Git：

```bash
git ls-remote https://github.com/issac-js/lexiloop.git refs/heads/sync/full-source-20261019
```

如果成功，在**已核对 origin 地址的原仓库**读取分支文档，无需切换工作区：

```bash
git fetch origin sync/full-source-20261019
git show FETCH_HEAD:docs/DEPLOYMENT.md
```

这不合并 main，也不覆盖本地文件。如果认证失败，使用现有 Git Credential Manager
官方浏览器授权，或给 WorkBuddy 的 GitHub 连接器授权该私有仓库；只读连接足以审阅。
不输出保存的凭据，不复制其他进程的凭据，不以匿名 URL 反复判断私有仓库状态。

## 已报告的发布约束与待验事项

原 WorkBuddy 项目报告：
- 更新工具为会话内 workbuddy_sites_deploy，用户必须当轮明确授权“发布”；
- 原绑定在 .wbapp_3mGfJgXC5sdFj1a25a9NhF.genie 和 .workbuddy/applications.yaml；
- 原上传目录 lexiloop/；应用 ID、正式 URL、云服务与用户须保持原样；
- 未发现可配置的外部部署入口，因此目前无需创建 GitHub 部署秘密。

这些本机绑定文件不提交到 GitHub。不得以打通自动部署为由绕过会话发布要求。
GitHub 端可检查、修复、提交 PR 和打包；WorkBuddy 端负责接收指定提交的发布包、
准备原应用目录，等待当轮发布授权后更新正式站点，再返回提交 SHA、URL 和验收结果。
暂不配置定时任务、本机 runner 或额外 OAuth 应用。

仍需首次授权发布来验证：release.json 是否被托管、22 个资源是否一致、
缓存刷新、多文件整体切换、浏览器 Service Worker 更新及静态回滚方式。
源代码审阅、离线 CI 和资源哈希不能替代登录、同步、模型与数据权限实测。

## 参考

- [WorkBuddy 网站应用开发与发布](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/App-Publishing/Web-App)
- [WorkBuddy Open API](https://open.workbuddy.cn/en/docs/openapi)

已查阅资料说明了 WorkBuddy 内更新发布和 OAuth/任务 API；尚未确认直接更新
既有静态托管应用的外部部署 API。不能将任务创建 API 当成已验证的部署接口。
