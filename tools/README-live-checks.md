# LexiLoop 线上验收工具

这些工具在 `verify_deployed.py` 的静态资源校验之外，补充指定隔离账号下的登录、
数据读取和应用壳截图。它们不是完整学习效果或生产数据权限审计。

## 环境与必填配置

需要 Node 22（全局 fetch/WebSocket）、安装好的 Edge 或 Chromium；无需 npm 依赖。
所有三个工具都要求以下配置，缺失或无效以退出码 2 结束：

| 变量 | 要求 |
| --- | --- |
| LEXILOOP_TEST_EMAIL | 已存在的隔离测试账号邮箱；服务端返回的邮箱必须匹配 |
| LEXILOOP_EXPECT_SHA | 期望线上版本的完整 40 位提交 SHA，不能省略 |
| LEXILOOP_EXPECT_VER | 期望应用版本，例如 108；不内置默认旧版本 |
| LEXILOOP_EDGE_PATH | 实际浏览器可执行文件路径；不依赖某台机器的默认路径 |
| LEXILOOP_QA_PROFILE | 专用 QA 浏览器目录；首次使用必须是空目录或尚不存在 |

`LEXILOOP_SITE` 默认正式站 HTTPS 根地址，可覆盖为已允许的测试站点。
`LEXILOOP_QA_OUT_DIR` 默认 `.workbuddy/qa/`，存本机 JSON/截图，不入库。
源码不内置密码、令牌、测试邮箱或用户目录；脚本不会自动读取 .env。

## 登录与独立浏览器目录

不要传入个人浏览器目录，也不要使用生产账号。首次运行在空 QA 目录中生成
绑定站点与测试邮箱哈希的标记；不同身份、非空无标记目录或并发运行都会拒绝。
标记不能替代服务端身份校验。每次验收还会核对服务端邮箱及应用用户 ID。

如果专用目录没有会话，可显式设置 `LEXILOOP_ALLOW_LOGIN=1`，并通过本机环境
提供 `LEXILOOP_TEST_PASSWORD`，使用**已有隔离账号**登录。默认不会登录。
没有有效会话且未允许登录时直接失败，不发送验证码、不注册账号、不设置新密码。
原始脚本的 OTP 临时文件交接已移除，避免自动发送邮件、误注册及遗留验证码文件。
首次登录完成后可取消登录开关并复用此 QA 目录。串行执行，不共用正在运行的浏览器。

## 运行

在上述变量已经配置的终端中执行：

```bash
python -B tools/verify_deployed.py --url https://lexiloop-82703.app.workbuddy.host/ --sha FULL_SHA
node tools/qa-release-live.js
node tools/qa-words-read-live.js
node tools/qa-release-shot.js
```

FULL_SHA 必须与 LEXILOOP_EXPECT_SHA 及本次实际发布提交一致，不能为了得到通过而
直接采用线上返回的任意值。PowerShell 设置非秘密配置的格式为
`$env:LEXILOOP_EXPECT_VER='108'`；密码通过本机安全方式设置，不复制到聊天或脚本。

`qa-release-live.js` 默认跳过模型调用。如本轮明确要验证模型通道，才设置
`LEXILOOP_RUN_MODEL=1`：完成身份与版本验证后放行至多一次模型 POST，可能消耗额度。
自动重试会被请求防护阻止并导致失败，不为了强求通过扩大调用权限。
其他两个工具不会因该开关而允许模型调用。

## 请求防护与副作用边界

导航前通过 CDP Fetch 在页面目标拦截请求。默认允许 GET/HEAD/OPTIONS 和同源
认证 token 刷新；显式登录时只额外允许既有账号 sign-in，模型开关按上述规则生效。
除下述统计读取外，其他 RPC、数据库写入、文件上传、注册、OTP 和其他非读取请求被阻止。
任何**非预期**被阻止的请求或防护错误都使验收失败，包括启动时尝试 flushPending。
不要为了让验收通过关闭防护；使用干净隔离测试数据并排查触发写入的原因。

### v108 的两条启动依赖

2026-10-20 的现场复测发现：v108 冷启动会调用统计 RPC，换日时还会尝试写今日计划。
旧策略将两者统称为意外写入，导致三个工具在 prepare 阶段全部失败；九组纯模拟测试
没有覆盖真实 store.js 的启动顺序，不能据此认为旧工具可在线使用。

- 对同源、精确路径 `/.cloud/database/rest/rpc/study_stats`、无查询参数、无入参的
  POST 调用，验收浏览器改为 **GET**，移除请求体和相关实体头，保留认证头。
  不放行统计 POST，不允许其他 RPC，也不支持带参数的同名调用。
  PostgREST 的 GET 使用只读事务；WorkBuddy 网关对 GET RPC 的支持还需现场复测。
  若服务器拒绝，验收失败，不自动回退 POST、不修改函数定义或数据库权限。
- 对形状符合 v108 pushSettings 的 settings upsert（owner_id 冲突键，含 day_plan
  的日期、due、newGoal）在本地返回明确的 **403 / QA_WRITE_SUPPRESSED**。
  请求不出浏览器、不落库；不伪造写入成功。应用本身已捕获该写入失败。
  记录 suppressedSettings 计数，并将持久化检查列为 skip，使汇总至少为 partial。
  这仅验证抑制写入条件下的读取/渲染，不是未经干预的完整启动验收。

审计区分 readRpc（改写次数）、suppressedSettings（本地抑制次数）、blocked
（意外拦截）和 guardErrors。仅后两者使防护断言失败；抑制不能被算作真实持久化通过。
blockedRoutes 仅记录预定义的安全路径类别，不含请求参数、正文或认证信息。
statsHttpStatuses 仅记录统计 RPC 的数值 HTTP 状态，便于区分 GET 不支持、鉴权失败和请求成功。
新回归直接加载仓库的 v108 store.js，覆盖换日同步及 GET 被拒绝时不得回退的路径。
测试中的网络响应仍为本地 fixture，不等于生产 SQL、真实浏览器或网关已经验证。

参考：[PostgREST 事务访问模式](https://docs.postgrest.org/en/stable/references/transactions.html)。

这不是“完全无副作用”：认证可能刷新会话，截图和 JSON 写入本机，显式模型调用
产生服务用量。防护基于当前 SDK 路径与页面 CDP 目标，不是通用浏览器安全沙箱。
验收浏览器绕过 Service Worker 的请求缓存以检查网络资源，因此不验证离线壳、
真实缓存交接、其他后台目标或部署原子性。正式站的未测流程仍需另行验证。

## 结果判读与退出码

每次输出 `RESULT_JSON=`，并保存带时间和进程号的 JSON。汇总 status 为：

- pass：本工具列出的断言全部通过。
- partial：已执行的断言通过，但有明确 skip；跳过项的 pass 为 false，不能算已验证。
- fail：断言失败、请求被阻止、超时、浏览器异常、账号/版本不符或结果保存失败。

退出码 0 表示执行范围内无失败（仍需看 partial/skip）；1 表示执行/断言失败；
2 表示配置错误。CDP 错误、断开及超时均拒绝，不会无限等待或总以成功退出。
输出不包含账号邮箱、用户 ID、完整页面文本或模型原始回复。
截图仍可能包含隔离账号内容，只在本机审阅，不自动上传。

零卡账号的 words=0 合法。非零卡而未水合词条会失败；空全局词库只能验证空读和计数，
ID 水合明确 skip。读取工具核对返回 ID 集合，不能仅凭行数相同就算通过。
截图工具只验证认证应用壳与 PNG 产出，视觉质量必须人工检查。
主工具明确跳过分页完整性、作答写入、FSRS 持久化和 SW 交接，不声称完整验收。

## 离线回归与维护

```bash
node --test tools/live-checks.test.js
python -B tools/ci_check.py
```

CI 只运行离线测试，不启动浏览器、登录、访问云库或调用模型。线上浏览器、平台协议、
实际登录和请求防护仍需 WorkBuddy 在隔离账号下现场复测；离线成功不代表它们已通过。
异常退出若留下 QA 锁，先确认对应 QA 浏览器确已退出，再人工清理专用目录中的锁。
