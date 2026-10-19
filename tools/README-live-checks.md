# LexiLoop 线上验收脚本（只读）

配合 [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) 的上线验收使用。`tools/verify_deployed.py`
只静态比对资源哈希，不碰登录、同步和模型；这三个脚本补的是**真链路**那一段。

三个脚本都是**只读**的：不写词卡、不写复习日志、不清任何数据。唯一的"写"是登录会话本身。

## 前置条件

| 项 | 要求 |
| --- | --- |
| Node.js | 20 及以上（脚本只用内建模块与全局 `fetch` / `WebSocket`，无需 npm 安装） |
| 浏览器 | Chromium 内核的 Edge（脚本通过 CDP 驱动无头模式，路径可用环境变量覆盖） |
| 账号 | **隔离测试账号**，与真实用户数据无关；不要使用生产账号 |

## 环境变量

凭据与本机路径一律从环境变量读取，源码里不内置任何账号、密码、令牌或用户目录。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `LEXILOOP_TEST_EMAIL` | **是**（`qa-release-live.js`） | 隔离测试账号邮箱。缺失时脚本直接退出并提示，不会猜 |
| `LEXILOOP_TEST_PASSWORD` | 否 | 仅该邮箱**首次注册**时设密码用。老账号走验证码登录，不需要 |
| `LEXILOOP_SITE` | 否 | 目标站点，默认正式站 |
| `LEXILOOP_EDGE_PATH` | 否 | Edge 可执行文件绝对路径，默认 Windows 常见安装位置 |
| `LEXILOOP_QA_PROFILE` | 否 | 浏览器 `user-data-dir`。**必须固定**：SDK 的验证码 challenge 存在 localStorage，换目录会丢 |
| `LEXILOOP_OTP_FILE` | 否 | 验证码交接文件，默认系统临时目录下的 `lexiloop-otp.txt` |
| `LEXILOOP_EXPECT_VER` | 否 | 期望的应用版本号，默认 `108` |
| `LEXILOOP_EXPECT_SHA` | 否 | 期望的源提交完整 SHA。未设置时只验 `release.json` 可读有值，不比对 |
| `LEXILOOP_QA_OUT_DIR` | 否 | 截图输出目录，默认仓库内 `.workbuddy/` |

## 脚本

```bash
# ① 主验收：启动无错 → 版本 → release.json → SW → 登录 → 同步 → 读链路 → 模型通道一次最小调用
LEXILOOP_TEST_EMAIL=隔离账号@example.com node tools/qa-release-live.js

# ② 词库读取链路直测：限量读 / 精确计数 / 按卡片 id 水合（.in('id', ...)）
node tools/qa-words-read-live.js

# ③ 用户视角：今日页渲染 + 截图（430×932 移动端视口）
node tools/qa-release-shot.js
```

## 验证码交接

`qa-release-live.js` 优先复用固定 profile 里的持久会话；没有会话时才发验证码：

1. 脚本填邮箱、点「获取验证码」，然后轮询 `LEXILOOP_OTP_FILE`。
2. 收码方从测试账号邮箱读到 6 位码后，把它写进该文件。
3. 脚本取码提交，等待应用进入主界面。

等待上限 240 秒，超时即失败退出，不会一直挂着。

## 结果判读

- 脚本退出前打印 `RESULT_JSON=`，逐项含 `n`（检查项）、`pass`（通过与否）、`d`（失败原因）。
- 主验收脚本同时把结果写入 `.workbuddy/release-acceptance-<日期>.json`。
- `pass` 为真的才是**实测通过**；脚本没覆盖到的链路一律不算通过，需要单独说明。

## 已知边界

- 测试账号通常没有卡片，而 `state.words` 是按卡片引用**按需水合**的 —— 零卡账号

  出现 `words=0` 是正确行为，不是同步故障。词库链路请另用脚本 ② 直测。

- 模型通道只做一次最小调用，判分稳定性需要多轮采样，不在本脚本范围内。
- 脚本不覆盖作答写入、FSRS 调度与 iOS 真机适配。
