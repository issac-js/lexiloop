# LexiLoop 检查与发布

## 当前状态

GitHub 自动离线检查和发布包已配置。WorkBuddy 的外部发布连接尚未验证；
工作流不会假装上线，不会发送请求到猜测的部署 API，也不会迁移数据库。
现有正式站点：<https://lexiloop-82703.app.workbuddy.host/>。

## 检查和固定发布来源

1. 在独立分支修复应用并用 `tools/bump_version.py` 更新版本。
2. 提交 PR，确认 `LexiLoop checks and release bundle / check` 成功。
3. 审核后合并到 main；等待 main 的检查成功。
4. 从该次 main 检查下载 `lexiloop-FULL_SHA` artifact，保存 ZIP 和 SHA-256 文件。
5. 发布 ZIP 内的文件到**现有应用**；根目录应为 index.html，不再套 lexiloop 子目录。
   不发布 server.py、tools、报告、环境文件或仓库根目录。
6. 保留上一份已验收的 ZIP、摘要和 SHA，以便静态代码回滚。

GitHub PR 的发布包标记 PR 源提交，合并后的发布包标记 main 提交；实际部署 main 的包。
私有仓库的 Actions 执行额度和 artifact 保留期受账户设置影响；本工作流保留产物 14 天，
长期回滚包需由部署端另行保存。新增公开静态资源时需更新 `PUBLIC_FILES` 白名单。

## 本地复现

在准备发布的干净 checkout 中运行（Python 3.12、Node 22；无需 npm/pip 安装）：

```bash
python -B tools/ci_check.py
python -B tools/release_bundle.py --sha FULL_SHA
```

FULL_SHA 必须是这个 checkout 的完整提交 SHA，不可随意填写。打包命令仅校验
SHA 格式，不证明工作区未修改；自动 CI 以固定 SHA checkout 保证来源对应。
ZIP 内的 release.json 记录 source_sha、app_version 和 22 个公开资源的 SHA-256。
它是版本标记，不是数字签名；不要把发布包放入 Git。

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

## 回滚

如静态资源验收或功能验收失败，在原应用重新发布上一份验收成功的 ZIP，
以其 FULL_SHA 重跑资源校验，再人工确认浏览器缓存更新和登录状态。
WorkBuddy 的发布缓存刷新与多文件原子性需要先验证；若平台不能保证整体切换，
必须记录短暂混用资源风险。Service Worker 可能需要用户点“检查更新”后才接管。
静态代码回滚不回滚数据库，本流程禁止执行数据库写入和结构迁移。

## 发布连接待办（在原 WorkBuddy 项目执行）

请让 WorkBuddy 查明以下内容，并将**不含秘密**的结果提交到独立分支：

- 现有应用的实际更新发布工具或官方 CLI 名称、参数结构、官方文档；
  既有应用标识为 wbapp_3mGfJgXC5sdFj1a25a9NhF，不能另建应用或更换数据源。
- 是否支持 GitHub 原生自动部署、外部 CI 官方 API、短期凭据或部署 webhook；
  所需权限、授权入口、凭据续期方式及域名，不返回令牌值或带密钥的 webhook URL。
- 若支持，把最小必要凭据直接配置到 GitHub 的 production 环境秘密中，
  不写源码、报告或聊天。GitHub 写仓库权限不等于 WorkBuddy 发布权限。
- 发布目录、更新同一 URL 的方法、缓存刷新、原子发布、历史版本回滚能力。
- 若只能在本机 WorkBuddy 已登录会话内发布，明确说明此限制，不将其称为云端自动部署。

确认受支持的连接后，才能编写实际 deploy job、进行一次真实发布并运行上述验收。
暂不安装本机 self-hosted runner；不能让普通 PR 在用户电脑上执行任意代码。

## 参考

- [WorkBuddy 网站应用开发与发布](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/App-Publishing/Web-App)
- [WorkBuddy Open API](https://open.workbuddy.cn/en/docs/openapi)

已查阅资料说明了 WorkBuddy 内更新发布和 OAuth/任务 API；尚未确认直接更新
既有静态托管应用的外部部署 API。不能将任务创建 API 当成已验证的部署接口。
