# 隔离浏览器与 iOS Safari 检查

本套件使用实际应用入口、模块和样式，只把本地测试服务器中的云 SDK 响应替换为合成数据夹具。
不使用生产账号、真实凭据、生产词库或模型；本地服务器仅绑定 `127.0.0.1`，云请求返回 403，CSP 禁止跨源连接。

## 检查层级

| 检查 | 环境与范围 | 不代表 |
| --- | --- | --- |
| `check` | Node 22 / Python 3.12；离线调度、预算和资源检查 | 浏览器或云网关实测 |
| `browser` | 实际 Chromium / WebKit；桌面、iPhone SE、较大 iPhone、横屏、iPad 配置 | 物理 iOS 设备 |
| `ios-safari` | macOS 托管运行器中的实际 iOS Simulator Safari；XCTest 原生点按与数字输入，页面内功能检查 | 物理 iPhone、生产鉴权、RLS 或真实网络持久化 |

三个 job 均须对准备合并的同一个提交通过。不得把浏览器夹具中的分页和保存结果写成生产数据库已验证。
任何 job 缺少浏览器、Simulator、结果文件或报告有 fail 时都失败，不以 skip 代替。

## Chromium / WebKit 本地复现

依赖单独安装在临时目录，不向无构建应用增加运行时依赖：

```bash
npm install --prefix /tmp/lexiloop-browser-deps --ignore-scripts --no-audit --no-fund playwright@1.62.1
node /tmp/lexiloop-browser-deps/node_modules/playwright/cli.js install --with-deps chromium webkit
NODE_PATH=/tmp/lexiloop-browser-deps/node_modules LEXILOOP_BROWSER_OUT_DIR=/tmp/lexiloop-browser-results node tools/browser-check.js
```

输出 JSON 包含 pass/fail、设备配置和每项结果；同目录保存页面 PNG。测试通过真实页面点击保存、推荐、学习评分，检查刷新、当日额度、短期阶段、积压开关、页面异常与网络边界。

## iOS Simulator

GitHub 工作流选择已安装的 iPhone Simulator，启动本地服务器，使用 XcodeGen 生成只供 UI 测试的启动器与 XCTest 工程。
启动器只打开环回 URL；Safari 的设置数字输入及保存由 XCTest 点按完成，随后页面内脚本通过实际 DOM 事件执行合成数据的学习流程。
测试同时保留竖屏和横屏截图，产物包含 Safari 报告、Xcode 日志、`.xcresult` 与最终屏幕 PNG。

页面内测试会推进夹具时钟以验证 10 分钟与跨日步骤；这不是实际等待了十分钟或一天。
物理键盘、音频、后台恢复、PWA 安装及生产 Service Worker 交接不在此套件的通过范围。

## 产物与发布

Actions 的 `browser-results-FULL_SHA` 与 `ios-safari-results-FULL_SHA` 为合成数据验收证据，保留 14 天；
`lexiloop-FULL_SHA` 才是发布候选包。合并 main 后重新确认 main 三项检查，并只准备该 main 提交的发布包。
工具、测试页面、启动器和验收截图均不在公开资源白名单，不随网站发布。
真实站点仍使用 `README-live-checks.md` 的受防护验收，发布与回滚遵循 `docs/DEPLOYMENT.md`。
