'use strict';
/* 取回云 SDK 并内置到 lexiloop/lexiloop/vendor/。
   为什么要内置：实测 cdn.jsdelivr.net 在本机会被间歇性重置
   （浏览器 net::ERR_CONNECTION_RESET / Node ECONNRESET）。
   SDK 加载失败时页面**照常打开、控制台零异常**，但认证/数据/云 AI 三条链路
   会**静默失效**——这是最难排查的一类故障。
   内置到同源后：不依赖外部 CDN、可被 Service Worker 缓存、离线也能起。

   多镜像 + 重试，任一成功即落盘并回读校验。
   用法：node tools/fetch-sdk.js [--force] */
const fs = require('fs');
const path = require('path');

const REL = '@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';
const MIRRORS = [
  'https://cdn.jsdelivr.net/npm/' + REL,
  'https://unpkg.com/' + REL,
  'https://cdn.jsdmirror.com/npm/' + REL,
  'https://npm.elemecdn.com/' + REL,
  'https://cdn.staticfile.net/' + REL,
];

const OUT_DIR = path.join(__dirname, '..', 'lexiloop', 'vendor');
const OUT = path.join(OUT_DIR, 'workbuddy-cloud-sdk.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryFetch(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) return { ok: false, why: 'HTTP ' + r.status };
    const t = await r.text();
    if (!/WorkBuddyCloud/.test(t)) return { ok: false, why: '内容不含 WorkBuddyCloud（可能不是预期文件）' };
    if (!/createWorkBuddyCloud/.test(t)) return { ok: false, why: '缺 createWorkBuddyCloud' };
    return { ok: true, text: t };
  } catch (e) {
    return { ok: false, why: (e && e.name === 'AbortError') ? '超时' : String((e && e.message) || e) };
  } finally { clearTimeout(timer); }
}

(async () => {
  if (fs.existsSync(OUT) && !process.argv.includes('--force')) {
    const cur = fs.readFileSync(OUT, 'utf8');
    if (/createWorkBuddyCloud/.test(cur) && /WorkBuddyCloud/.test(cur)) {
      console.log('已存在且校验通过，跳过下载：' + OUT + ' (' + cur.length + ' 字节)');
      console.log('（要强制更新请加 --force）');
      return 0;
    }
    console.log('已存在但校验失败，重新下载…');
  }

  for (let round = 1; round <= 3; round++) {
    for (const url of MIRRORS) {
      process.stdout.write('  尝试 ' + url + ' … ');
      const r = await tryFetch(url);
      if (r.ok) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(OUT, r.text, 'utf8');
        const back = fs.readFileSync(OUT, 'utf8');
        if (back.length !== r.text.length) { console.log('\n!! 回读长度不一致，放弃'); return 1; }
        console.log('成功 (' + r.text.length + ' 字节)');
        console.log('\n已内置：' + OUT);
        console.log('回读校验：' + back.length + ' 字节 ✅');
        return 0;
      }
      console.log('失败：' + r.why);
      await sleep(600);
    }
    if (round < 3) console.log('--- 第 ' + round + ' 轮全部失败，稍后重试 ---');
  }
  console.log('\n!! 所有镜像均失败。请检查网络后重试，或手动把 index.global.js 放到 ' + OUT);
  return 1;
})().then((c) => process.exit(c));
