#!/usr/bin/env node
/**
 * tools/test-bili-client.mjs
 * feiyu-connector/lib/bili.js 行为测试（零依赖，真实请求 B 站公开接口）。
 *
 * 依据：docs/spec-feiyu-connector.md §5（精确 API）与 §7（验证项）。
 * 用法：node tools/test-bili-client.mjs [--json]
 *   --json  : 只输出一份 JSON 结果（供验证报告生成用）
 * 退出码：0 = 全部 PASS（允许 SKIP）；1 = 有 FAIL，或 feiyu-connector 尚未就绪。
 *
 * 约束：网络单次 15s 超时（每个检查项整体 15s）；不写磁盘；可重复运行（每次先 cacheClear）。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TIMEOUT_MS = 15_000
const JSON_MODE = process.argv.includes('--json')
const TARGET = fileURLToPath(new URL('../feiyu-connector/lib/bili.js', import.meta.url))

const results = []
const state = { hotFull: [], rankFirst: null }

const clip = (s, n = 90) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
const record = (id, status, detail = '') => results.push({ id, status, detail: clip(detail, 200) })
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const has = (v) => v !== undefined && v !== null
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

function notReady(reason) {
  record('module-ready', 'SKIP', reason)
  if (JSON_MODE) {
    console.log(JSON.stringify({ ok: false, ready: false, reason, target: TARGET, pass: 0, fail: 0, skip: 1, results }, null, 2))
  } else {
    console.log(`[SKIP] module-ready           ${reason}`)
    console.log('')
    console.log('PASS 0 / FAIL 0 / SKIP 1')
    console.log('RESULT: NOT_READY（feiyu-connector 尚未就绪）')
    console.log('')
    console.log('feiyu-connector 尚未就绪：待构建方产出 feiyu-connector/lib/bili.js 后重新运行本脚本。')
    console.log(`缺失目标：${TARGET}`)
  }
  process.exit(1)
}

if (!existsSync(TARGET)) notReady('找不到 feiyu-connector/lib/bili.js')

let bili
try {
  bili = await import(pathToFileURL(TARGET).href)
} catch (err) {
  notReady(`目标文件存在但 import 失败：${err?.message ?? err}`)
}

function withTimeout(promise, label) {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`超时：${label} 在 ${TIMEOUT_MS / 1000}s 内未返回`)), TIMEOUT_MS)
  })
  return Promise.race([Promise.resolve(promise), guard]).finally(() => clearTimeout(timer))
}

async function check(id, fn) {
  try {
    const detail = await withTimeout(fn(), id)
    record(id, 'PASS', detail ?? 'ok')
  } catch (err) {
    record(id, 'FAIL', err?.message ?? err)
  }
}

/** 优先用 ranking 首条 bvid；失败则退回搜索首条。 */
async function pickBvid() {
  if (state.rankFirst) return state.rankFirst
  const r = await bili.searchVideos({ keyword: '原神' })
  const bv = r?.items?.[0]?.bvid
  assert(/^BV[0-9A-Za-z]{10}$/.test(String(bv ?? '')), '无法获得可用 bvid（ranking 与 searchVideos 均未返回）')
  return bv
}

const tests = []

tests.push(['exports', async () => {
  const names = ['hotSearch', 'ranking', 'searchVideos', 'videoDetail', 'videoComments']
  const missing = names.filter((n) => typeof bili[n] !== 'function')
  assert(missing.length === 0, `缺少导出函数：${missing.join(', ')}`)
  assert(bili.__test__ && typeof bili.__test__ === 'object', '缺少 __test__ 导出')
  return '5 个函数 + __test__ 就绪'
}])

tests.push(['no-stdout-log', async () => {
  bili.__test__?.cacheClear?.()
  const captured = []
  const orig = { log: console.log, info: console.info, debug: console.debug }
  try {
    console.log = (...a) => captured.push(a.join(' '))
    console.info = (...a) => captured.push(a.join(' '))
    console.debug = (...a) => captured.push(a.join(' '))
    await bili.hotSearch({ limit: 3 })
  } finally {
    Object.assign(console, orig)
  }
  assert(captured.length === 0, `调用期间向 stdout 打印 ${captured.length} 次：${clip(captured[0])}`)
  return '调用 hotSearch 期间无 stdout 日志'
}])

tests.push(['hotSearch', async () => {
  bili.__test__?.cacheClear?.()
  const t0 = performance.now()
  const r = await bili.hotSearch({ limit: 10 })
  const ms = performance.now() - t0
  const list = r?.keywords
  assert(Array.isArray(list), '返回值缺 keywords 数组')
  assert(list.length >= 5, `keywords 数量 ${list.length} < 5`)
  list.forEach((it, i) => {
    assert(typeof it?.keyword === 'string' && it.keyword.trim(), `第 ${i + 1} 条 keyword 为空`)
    assert(typeof it?.url === 'string' && /^https:\/\/search\.bilibili\.com\/all\?keyword=/.test(it.url), `第 ${i + 1} 条 url 不合规：${clip(it?.url)}`)
    assert(it.url.includes(encodeURIComponent(it.keyword)), `第 ${i + 1} 条 url 未包含 encodeURIComponent(keyword)`)
    if (has(it.hot)) assert(isNum(it.hot), `第 ${i + 1} 条 hot 非 number`)
  })
  state.hotFull = list
  return `${list.length} 条（${ms.toFixed(0)}ms），首条「${clip(list[0].keyword, 18)}」`
}])

tests.push(['hotSearch-filter', async () => {
  const r = await bili.hotSearch({ keyword: '原神' })
  const list = r?.keywords
  assert(Array.isArray(list), '返回值缺 keywords 数组')
  const bad = list.filter((it) => !String(it?.keyword ?? '').toLowerCase().includes('原神'))
  assert(bad.length === 0, `过滤后有 ${bad.length} 条不含「原神」：${clip(bad[0]?.keyword)}`)
  if (state.hotFull.length) assert(list.length <= state.hotFull.length, `过滤结果 ${list.length} 条多于全量 ${state.hotFull.length} 条`)
  return `命中 ${list.length} 条（无命中返回空数组亦合规）`
}])

tests.push(['ranking', async () => {
  const r = await bili.ranking({ limit: 20 })
  const items = r?.items
  assert(Array.isArray(items), '返回值缺 items 数组')
  assert(items.length >= 10, `items 数量 ${items.length} < 10`)
  items.forEach((it, i) => {
    assert(/^BV[0-9A-Za-z]{10}$/.test(String(it?.bvid ?? '')), `第 ${i + 1} 条 bvid 不合规：${clip(it?.bvid)}`)
    assert(typeof it?.title === 'string' && it.title.trim(), `第 ${i + 1} 条 title 为空`)
    assert(!it.title.includes('<'), `第 ${i + 1} 条 title 含 HTML 标签：${clip(it.title)}`)
    assert(isNum(it?.view), `第 ${i + 1} 条 view 非 number`)
    assert(isNum(it?.like), `第 ${i + 1} 条 like 非 number`)
    assert(it.videoUrl === `https://www.bilibili.com/video/${it.bvid}`, `第 ${i + 1} 条 videoUrl 不合规：${clip(it.videoUrl)}`)
    assert(has(it?.owner), `第 ${i + 1} 条缺 owner`)
    assert(has(it?.cover), `第 ${i + 1} 条缺 cover`)
  })
  state.rankFirst = items[0].bvid
  return `${items.length} 条，首条 ${items[0].bvid}「${clip(items[0].title, 24)}」`
}])

tests.push(['searchVideos', async () => {
  const r = await bili.searchVideos({ keyword: '原神' })
  assert(isNum(r?.total), `total 非 number：${clip(r?.total)}`)
  const items = r?.items
  assert(Array.isArray(items), '缺 items 数组')
  assert(items.length >= 5, `items 数量 ${items.length} < 5`)
  items.forEach((it, i) => {
    assert(/^BV[0-9A-Za-z]{10}$/.test(String(it?.bvid ?? '')), `第 ${i + 1} 条 bvid 不合规：${clip(it?.bvid)}`)
    assert(typeof it?.title === 'string' && it.title.trim(), `第 ${i + 1} 条 title 为空`)
    assert(!it.title.includes('<'), `第 ${i + 1} 条 title 含 HTML 标签：${clip(it.title)}`)
    assert(typeof it?.description === 'string', `第 ${i + 1} 条 description 非 string`)
    assert(!it.description.includes('<'), `第 ${i + 1} 条 description 含 HTML 标签`)
    assert(it.description.length <= 123, `第 ${i + 1} 条 description 长度 ${it.description.length} > 120 字（允许 3 字省略号余量）`)
  })
  return `total=${r.total}，返回 ${items.length} 条`
}])

tests.push(['videoDetail', async () => {
  const bvid = await pickBvid()
  const v = await bili.videoDetail({ bvid })
  assert(isNum(v?.aid), `aid 非 number：${clip(v?.aid)}`)
  assert(v?.bvid === bvid, `返回 bvid 与入参不一致：${clip(v?.bvid)}`)
  assert(typeof v?.title === 'string' && v.title.trim(), 'title 为空')
  assert(isNum(v?.view) && isNum(v?.like) && isNum(v?.coin) && isNum(v?.favorite) && isNum(v?.share), 'view/like/coin/favorite/share 存在非 number')
  assert(has(v?.pubdate), '缺 pubdate')
  assert(String(v?.videoUrl ?? '').includes(bvid), `videoUrl 未含 bvid：${clip(v?.videoUrl)}`)
  return `${bvid} aid=${v.aid} 播放=${v.view}「${clip(v.title, 24)}」`
}])

tests.push(['videoComments', async () => {
  const bvid = await pickBvid()
  const r = await bili.videoComments({ bvid, limit: 5 })
  assert(isNum(r?.count), `count 非 number：${clip(r?.count)}`)
  const items = r?.items
  assert(Array.isArray(items), '缺 items 数组')
  assert(items.length <= 5, `items 数量 ${items.length} 超过 limit=5`)
  items.forEach((it, i) => {
    assert(has(it?.user), `第 ${i + 1} 条缺 user`)
    assert(typeof it?.message === 'string', `第 ${i + 1} 条 message 非 string`)
    if (has(it.like)) assert(isNum(it.like), `第 ${i + 1} 条 like 非 number`)
    if (has(it.replies)) assert(isNum(it.replies), `第 ${i + 1} 条 replies 非 number`)
  })
  return `count=${r.count}，取回 ${items.length} 条${items.length ? `，首条「${clip(items[0].message, 30)}」` : '（可能无人评论/已关闭，空数组合规）'}`
}])

tests.push(['videoDetail-error', async () => {
  try {
    await bili.videoDetail({ bvid: 'BV0000000000' })
  } catch (err) {
    const m = String(err?.message ?? err)
    assert(/视频不存在|已失效/.test(m), `抛错信息不符合 spec（期望「视频不存在或已失效」），实际：${clip(m)}`)
    return `抛出：${clip(m, 40)}`
  }
  throw new Error('未抛错（spec 要求 bvid 无效时抛 Error）')
}])

tests.push(['searchVideos-error', async () => {
  try {
    await bili.searchVideos({})
  } catch (err) {
    const m = String(err?.message ?? err)
    assert(m.includes('keyword') && m.includes('不能为空'), `抛错信息不符合 spec（期望「keyword 不能为空」），实际：${clip(m)}`)
    return `抛出：${clip(m, 40)}`
  }
  throw new Error('未抛错（spec 要求 keyword 缺省时抛 Error）')
}])

tests.push(['cache-api', async () => {
  assert(typeof bili.__test__?.cacheClear === 'function', '__test__.cacheClear 不是 function')
  bili.__test__.cacheClear()
  const extra = ['mixinKey', 'signParams'].filter((k) => typeof bili.__test__?.[k] !== 'function')
  return `cacheClear 可调用${extra.length ? `；备注：__test__ 缺 ${extra.join('/')}（§5 声明，§7 未强制）` : '；mixinKey/signParams 齐备'}`
}])

tests.push(['cache-timing', async () => {
  bili.__test__?.cacheClear?.()
  const t1s = performance.now()
  await bili.hotSearch({ limit: 10 })
  const t1 = performance.now() - t1s
  const t2s = performance.now()
  await bili.hotSearch({ limit: 10 })
  const t2 = performance.now() - t2s
  if (t1 < 20) return `首次 ${t1.toFixed(1)}ms 过快，无法判定缓存收益（cache-api 已覆盖）`
  assert(t2 < t1 * 0.6, `第二次 ${t2.toFixed(1)}ms 未低于第一次 ${t1.toFixed(1)}ms 的 60%（缓存可能未生效）`)
  return `首次 ${t1.toFixed(1)}ms → 第二次 ${t2.toFixed(1)}ms（${((t2 / t1) * 100).toFixed(0)}%）`
}])

let blocked = false
for (const [id, fn] of tests) {
  if (blocked) {
    record(id, 'SKIP', 'exports 检查未通过，后续无法执行')
    continue
  }
  await check(id, fn)
  if (id === 'exports' && results[results.length - 1].status === 'FAIL') blocked = true
}

const p = results.filter((r) => r.status === 'PASS').length
const f = results.filter((r) => r.status === 'FAIL').length
const s = results.filter((r) => r.status === 'SKIP').length
const ok = f === 0

if (JSON_MODE) {
  console.log(JSON.stringify({ ok, target: TARGET, pass: p, fail: f, skip: s, results }, null, 2))
} else {
  console.log(`feiyu-connector/lib/bili.js 行为测试（真实请求 B 站接口）`)
  console.log(`目标：${TARGET}`)
  console.log('')
  for (const r of results) console.log(`[${r.status}] ${r.id.padEnd(22)} ${r.detail}`)
  console.log('')
  console.log(`PASS ${p} / FAIL ${f} / SKIP ${s}`)
  console.log(`RESULT: ${ok ? 'PASS' : 'FAIL'}`)
}

process.exitCode = ok ? 0 : 1
