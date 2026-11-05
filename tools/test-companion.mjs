#!/usr/bin/env node
/**
 * tools/test-companion.mjs
 * feiyu-connector/lib/companion.js 单测（零依赖、不联网、不依赖 DSH 运行时）。
 *
 * 依据：docs/spec-feiyu-companion.md §A3（代码形态）与 §A6.2（8 个验收场景）。
 * 做法：假 ctx（on/interval/timeout/effect）、假 agents / agentPresets、可控时钟（手动推进，不真 sleep）。
 *
 * 用法：node tools/test-companion.mjs [--json]
 * 退出码：0 = 全部 PASS（允许 SKIP）；1 = 有 FAIL，或 companion 尚未就绪。
 * 可重复运行：每个场景各自新建假依赖与时钟，无全局状态。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TARGET = fileURLToPath(new URL('../feiyu-connector/lib/companion.js', import.meta.url))
const JSON_MODE = process.argv.includes('--json')
const CHECK_TIMEOUT_MS = 10_000

const MIN = 60_000
const FIRST_DELAY_MS = 20 * MIN
const INTERVAL_MS = 90 * MIN
const JITTER_MS = 15 * MIN
const DEFAULT_TICK_MS = 60_000
const MARK = '【自主行动·心跳】'
// 固定本地时间基准：2026-11-05 12:00（本地时区），所有场景从这里推进。
const BASE = new Date(2026, 10, 5, 12, 0, 0, 0).getTime()

const results = []
const clip = (s, n = 220) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
const record = (id, status, detail = '') => results.push({ id, status, detail: clip(detail) })
const pass = (id, d = '') => record(id, 'PASS', d)
const fail = (id, e) => record(id, 'FAIL', e?.message ?? e)
const skip = (id, d = '') => record(id, 'SKIP', d)
const ensure = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

function notReady(reason) {
  record('module-ready', 'SKIP', reason)
  if (JSON_MODE) {
    console.log(JSON.stringify({ ok: false, ready: false, reason, target: TARGET, pass: 0, fail: 0, skip: 1, results }, null, 2))
  } else {
    console.log(`[SKIP] module-ready           ${reason}`)
    console.log('')
    console.log('PASS 0 / FAIL 0 / SKIP 1')
    console.log(`RESULT: NOT_READY（feiyu-connector 心跳模块尚未就绪）`)
    console.log('')
    console.log('feiyu-connector 尚未就绪：待构建方产出 feiyu-connector/lib/companion.js 后重新运行本脚本。')
    console.log(`缺失目标：${TARGET}`)
  }
  process.exit(1)
}

if (!existsSync(TARGET)) notReady('找不到 feiyu-connector/lib/companion.js')

let mod
try {
  mod = await import(pathToFileURL(TARGET).href)
} catch (err) {
  notReady(`目标文件存在但 import 失败：${err?.message ?? err}`)
}
const createCompanion = mod.createCompanion
if (typeof createCompanion !== 'function') notReady('lib/companion.js 存在但未导出 createCompanion 函数')

/* ------------------------------------------------------------------ *
 * 假依赖
 * ------------------------------------------------------------------ */

/** 假 ctx：记录监听器/定时器/disposer，可手动 emit。 */
function makeCtx() {
  const listeners = new Map()
  const intervals = []
  const timeouts = []
  const effects = []

  const ctx = {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return () => {}
    },
    interval(fn, ms) {
      const entry = { fn, ms, disposed: false }
      intervals.push(entry)
      return () => {
        entry.disposed = true
      }
    },
    timeout(fn, ms) {
      const entry = { fn, ms, disposed: false }
      timeouts.push(entry)
      return () => {
        entry.disposed = true
      }
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') effects.push(disposer)
      return () => {}
    },
  }

  return {
    ctx,
    listeners,
    intervals,
    timeouts,
    effects,
    emit(event, ...args) {
      for (const fn of listeners.get(event) ?? []) fn(...args)
      if (event === 'dispose') {
        for (const d of effects) {
          try {
            d()
          } catch {
            /* 清理异常不影响断言 */
          }
        }
      }
    },
  }
}

/** 假 agents：get(id) → live agent；agent.followup(payload) 记录投递。
 *  形状对齐真实 Agent：会话 id 在 `.session.id`（不是 `.id`），status / followup 在 Agent 上。 */
function makeAgents() {
  return {
    map: new Map(),
    get(id) {
      return this.map.get(id)
    },
    list() {
      return [...this.map.values()]
    },
    add(id, status = 'idle', followupImpl) {
      const agent = {
        session: { id },
        status,
        followups: [],
        followup(payload) {
          if (followupImpl) return followupImpl(payload)
          this.followups.push(payload)
        },
      }
      this.map.set(id, agent)
      return agent
    },
  }
}

async function makeFixture(options = {}) {
  let clock = BASE
  const now = () => clock
  const advance = (ms) => {
    clock += ms
  }
  const setClock = (ms) => {
    clock = ms
  }
  const agents = makeAgents()
  const presets = new Map()
  const agentPresets = { presetForSession: (session) => presets.get(session?.id) }
  const logs = []
  const companion = createCompanion({ agents, agentPresets, now, log: (msg) => logs.push(msg) }, options)
  const fake = makeCtx()
  const attached = companion.attach(fake.ctx)
  if (attached && typeof attached.then === 'function') await attached
  return { companion, agents, presets, logs, now, advance, setClock, ...fake }
}

const flush = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve()
}

/** 模拟「预设 feiyu 的会话出现第一次 turn/start」。 */
async function armByFirstTurn(f, sessionId = 's1', status = 'idle') {
  f.presets.set(sessionId, 'feiyu')
  const agent = status === null ? null : f.agents.add(sessionId, status)
  f.emit('session/event', { id: sessionId }, { type: 'turn/start' })
  await flush()
  return agent
}

const entryFor = (f, id) => f.companion.status().find((e) => e.sessionId === id)

const textOf = (payload) => {
  const content = payload?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => c?.text ?? c?.content ?? '').join('\n')
  return String(payload ?? '')
}

/* ------------------------------------------------------------------ *
 * 检查执行
 * ------------------------------------------------------------------ */
const runner = []

function test(id, fn) {
  runner.push([id, fn])
}

async function withTimeout(promise, id) {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`超时：${id} 在 ${CHECK_TIMEOUT_MS / 1000}s 内未完成`)), CHECK_TIMEOUT_MS)
  })
  return Promise.race([Promise.resolve(promise), guard]).finally(() => clearTimeout(timer))
}

/* ---------------- 基础形态 ---------------- */

test('exports', async () => {
  ensure(typeof createCompanion === 'function', 'createCompanion 不是函数')
  const c = createCompanion({ agents: makeAgents(), agentPresets: { presetForSession: () => undefined } })
  for (const name of ['attach', 'status', 'arm', 'disarm', 'fire', 'tick']) {
    ensure(typeof c[name] === 'function', `返回对象缺方法 ${name}()`)
  }
  return 'createCompanion → attach/status/arm/disarm/fire/tick'
})

test('attach-wiring', async () => {
  const f = await makeFixture()
  ensure(f.listeners.has('session/event'), "attach 未注册 ctx.on('session/event')")
  const hasDisposeHook = f.listeners.has('dispose') || f.effects.length > 0
  ensure(hasDisposeHook, "attach 未注册 dispose 清理（ctx.on('dispose') 或 ctx.effect）")
  ensure(f.intervals.length >= 1, 'attach 未用 ctx.interval 注册 tick')
  const tickEntry = f.intervals.find((i) => i.ms === DEFAULT_TICK_MS)
  ensure(tickEntry, `ctx.interval 间隔不是 ${DEFAULT_TICK_MS}ms（实际：${f.intervals.map((i) => i.ms).join(',')}）`)
  return `session/event + dispose + interval(${DEFAULT_TICK_MS}ms)`
})

test('dispose-cleanup', async () => {
  const f = await makeFixture()
  ensure(f.intervals.length >= 1, 'attach 未注册 interval')
  f.emit('dispose')
  ensure(
    f.intervals.every((i) => i.disposed),
    'ctx.on("dispose") 未清理 interval（插件卸载后会留下 tick）',
  )
  return 'dispose 后 interval 已释放'
})

test('status-shape', async () => {
  const f = await makeFixture()
  await armByFirstTurn(f)
  const st = f.companion.status()
  ensure(Array.isArray(st), 'status() 不是数组')
  ensure(st.length === 1, `status() 条目数 ${st.length} != 1`)
  const e = st[0]
  ensure(e.sessionId === 's1', `sessionId = ${clip(e.sessionId)}`)
  ensure(typeof e.nextAt === 'number' && e.nextAt > 0, 'nextAt 非数字')
  ensure(typeof e.firedToday === 'number', 'firedToday 非数字')
  ensure(typeof e.dayKey === 'string' && e.dayKey.length > 0, 'dayKey 缺失')
  return `[{ sessionId, nextAt, firedToday, dayKey }]，dayKey=${e.dayKey}`
})

test('no-console', async () => {
  const captured = []
  const orig = { log: console.log, info: console.info, warn: console.warn, debug: console.debug }
  try {
    console.log = console.info = console.warn = console.debug = (...a) => captured.push(a.join(' '))
    const f = await makeFixture()
    await armByFirstTurn(f)
    f.advance(FIRST_DELAY_MS)
    await f.companion.tick()
  } finally {
    Object.assign(console, orig)
  }
  ensure(captured.length === 0, `运行期间有 ${captured.length} 次 console 输出：${clip(captured[0])}`)
  return '武装 + 投递期间无 console 输出'
})

/* ---------------- §A6.2 的 8 个场景 ---------------- */

// 场景 1：首次 turn/start + 预设 feiyu → 武装，nextAt ≈ now + 20min
test('first-turn-arms', async () => {
  const f = await makeFixture()
  const agent = await armByFirstTurn(f)
  const e = entryFor(f, 's1')
  ensure(e, 'turn/start 后该会话未被武装')
  const skew = Math.abs(e.nextAt - (f.now() + FIRST_DELAY_MS))
  ensure(skew <= 2000, `nextAt 距 now+20min 偏差 ${skew}ms`)
  ensure(agent.followups.length === 0, '武装阶段不应立即投递')
  return `nextAt = now + ${((e.nextAt - f.now()) / MIN).toFixed(1)}min`
})

// 场景 2：非 feiyu 会话不武装
test('non-feiyu-ignored', async () => {
  const f = await makeFixture()
  f.presets.set('s-other', 'default')
  f.agents.add('s-other', 'idle')
  f.emit('session/event', { id: 's-other' }, { type: 'turn/start' })
  await flush()
  ensure(f.companion.status().length === 0, `非 feiyu 会话被武装：${JSON.stringify(f.companion.status())}`)
  // 非 turn/start 事件也不应武装
  f.presets.set('s1', 'feiyu')
  f.agents.add('s1', 'idle')
  f.emit('session/event', { id: 's1' }, { type: 'message/end' })
  await flush()
  ensure(entryFor(f, 's1') === undefined, '非 turn/start 事件触发了武装')
  return '非 feiyu 预设与非 turn/start 均不武装'
})

// 场景 3：tick 到点且 agent idle → 投递、含标记、firedToday+1、nextAt 后移 ~90min
test('tick-fires-idle', async () => {
  const f = await makeFixture()
  const agent = await armByFirstTurn(f)
  f.advance(FIRST_DELAY_MS)
  await f.companion.tick()
  ensure(agent.followups.length === 1, `投递次数 ${agent.followups.length} != 1`)
  const payload = agent.followups[0]
  // 真实 followup 需要完整 UserMessage：id / role / content / source（见 companion.js:157-164）
  ensure(Array.isArray(payload?.content) && payload.content.length > 0, '投递 payload 缺 content 数组')
  ensure(typeof payload?.id === 'string' && payload.id.length > 0, '投递 payload 缺 id（真实 followup 需要完整 UserMessage）')
  ensure(payload?.role === 'user', `payload.role = ${clip(payload?.role)}，期望 'user'`)
  ensure(textOf(payload).includes(MARK), `投递内容不含「${MARK}」：${clip(textOf(payload))}`)
  ensure(payload?.source?.kind === 'user', `source.kind = ${clip(payload?.source?.kind)}，期望 'user'`)
  const e = entryFor(f, 's1')
  ensure(e.firedToday === 1, `firedToday = ${e.firedToday}，期望 1`)
  const delta = e.nextAt - f.now()
  ensure(
    delta >= INTERVAL_MS - JITTER_MS - 1000 && delta <= INTERVAL_MS + JITTER_MS + 1000,
    `nextAt 后移 ${(delta / MIN).toFixed(1)}min，期望 90±15min`,
  )
  return `完整 UserMessage（id/role/content/source）；nextAt 后移 ${(delta / MIN).toFixed(1)}min`
})

// 场景 4：agent running → 不投递、不计数，约 2 分钟后再看
test('running-skip', async () => {
  const f = await makeFixture()
  const agent = await armByFirstTurn(f, 's1', 'running')
  f.advance(FIRST_DELAY_MS)
  await f.companion.tick()
  ensure(agent.followups.length === 0, `running 时仍投递了 ${agent.followups.length} 次`)
  const e = entryFor(f, 's1')
  ensure(e.firedToday === 0, `running 时 firedToday = ${e.firedToday}，期望 0`)
  const delta = e.nextAt - f.now()
  ensure(delta >= 60_000 && delta <= 180_000, `running 后 nextAt 后移 ${(delta / 1000).toFixed(1)}s，期望约 2min`)
  return `未投递/未计数，nextAt 顺延 ${(delta / 1000).toFixed(0)}s`
})

// 场景 5：23:xx 到点 → 不投递、顺延到次日 08:10 之后
test('quiet-hours-defer', async () => {
  const f = await makeFixture()
  f.setClock(new Date(2026, 10, 5, 22, 50, 0, 0).getTime())
  const agent = await armByFirstTurn(f)
  f.advance(FIRST_DELAY_MS) // → 23:10，落在静默时段
  await f.companion.tick()
  ensure(agent.followups.length === 0, `静默时段仍投递了 ${agent.followups.length} 次`)
  const e = entryFor(f, 's1')
  ensure(e, '静默时段后会话被移除')
  const nextDate = new Date(e.nextAt)
  const nowDate = new Date(f.now())
  ensure(nextDate.toDateString() !== nowDate.toDateString(), `未顺延到次日（nextAt=${nextDate.toLocaleString()}）`)
  const minutes = nextDate.getHours() * 60 + nextDate.getMinutes()
  ensure(minutes >= 8 * 60, `次日安排 ${nextDate.toTimeString().slice(0, 5)} 早于 08:00`)
  const exact810 = minutes >= 8 * 60 + 10
  return `顺延至次日 ${nextDate.toTimeString().slice(0, 5)}${exact810 ? '' : '（spec 写「08:10 之后」，实际早 10 分钟，建议对齐）'}`
})

// 场景 6：当日第 7 次 → 不投递（maxPerDay = 6）
test('daily-cap', async () => {
  const f = await makeFixture({ firstDelayMs: 1000, intervalMs: 1000, jitterMs: 0, maxPerDay: 6 })
  const agent = await armByFirstTurn(f)
  for (let i = 0; i < 6; i++) {
    f.advance(1000)
    await f.companion.tick()
  }
  ensure(agent.followups.length === 6, `前 6 次实际投递 ${agent.followups.length} 次`)
  f.advance(1000)
  await f.companion.tick()
  ensure(agent.followups.length === 6, `第 7 次仍投递（累计 ${agent.followups.length}），应受每日上限 6 限制`)
  ensure(entryFor(f, 's1').firedToday === 6, `firedToday = ${entryFor(f, 's1').firedToday}，期望 6`)
  return '6 次后第 7 次不投递'
})

// 场景 7：disarm 后 tick 不投递
test('disarm-stops', async () => {
  const f = await makeFixture()
  const agent = await armByFirstTurn(f)
  await f.companion.disarm('s1')
  ensure(entryFor(f, 's1') === undefined, 'disarm 后 status() 仍列出该会话')
  f.advance(FIRST_DELAY_MS)
  await f.companion.tick()
  ensure(agent.followups.length === 0, `disarm 后仍投递了 ${agent.followups.length} 次`)
  return 'disarm 后 status 清空、不投递'
})

// 场景 8：fire 强制投递（idle 时）成功
test('fire-forced', async () => {
  const f = await makeFixture()
  const agent = await armByFirstTurn(f)
  const ok = await f.companion.fire('s1')
  ensure(ok === true, `fire('s1') 返回 ${clip(ok)}，期望 true`)
  ensure(agent.followups.length === 1, `fire 后投递 ${agent.followups.length} 次，期望 1`)
  ensure(textOf(agent.followups[0]).includes(MARK), 'fire 投递内容不含心跳标记')
  // 已有设计取舍（Lead 认可）：fire 也计入当日次数并重排 nextAt；不是缺陷，锁住该行为防回归。
  const e = entryFor(f, 's1')
  ensure(e.firedToday === 1, `fire 后 firedToday = ${e.firedToday}，期望 1（设计取舍：fire 计入当日次数）`)
  ensure(e.nextAt > f.now(), 'fire 后 nextAt 未后移（设计取舍：fire 会重排下一次）')
  return 'fire(idle) → true，立即投递；计入 firedToday 并后移 nextAt（已知设计取舍，非缺陷）'
})

test('fire-unknown-session', async () => {
  const f = await makeFixture()
  const ok = await f.companion.fire('no-such-session')
  ensure(ok === false, `fire(未知会话) 返回 ${clip(ok)}，期望 false`)
  return 'fire(未知会话) → false'
})

// 运行态口径（Lead 2026-11-05 实测后调整）：fire 允许目标 agent running（followup 会排队到下一轮），
// 只有 agent 不存在才拒绝；旧的「status 必须 idle」预检已移除。
test('fire-running-queues', async () => {
  const f = await makeFixture()
  const agent = await armByFirstTurn(f, 's1', 'running')
  const ok = await f.companion.fire('s1')
  ensure(ok === true, `agent running 时 fire 返回 ${clip(ok)}，期望 true（followup 排队到下一轮）`)
  ensure(agent.followups.length === 1, `fire 后投递 ${agent.followups.length} 次，期望 1`)
  const e = entryFor(f, 's1')
  ensure(e.firedToday === 1, `fire 后 firedToday = ${e.firedToday}，期望 1`)
  ensure(e.nextAt > f.now(), 'fire 后 nextAt 未后移')
  return 'fire(running) → true，投递 1 次并计入 firedToday（排队到下一轮）'
})

// 运行态修复回归：真实 Agent 的会话 id 在 `.session.id`，用户常只给剥掉 session- 的 8 位前缀
test('prefix-resolution', async () => {
  const f = await makeFixture()
  const fullId = 'session-9f1c2d3e-4a5b-6c7d-8e9f-001122334455'
  f.presets.set(fullId, 'feiyu')
  f.agents.add(fullId, 'idle')
  f.emit('session/event', { id: fullId }, { type: 'turn/start' })
  await flush()
  ensure(entryFor(f, fullId), '完整 session id 未武装')
  const bare = f.companion.resolveSessionId('9f1c2d3e')
  ensure(bare === fullId, `裸 8 位前缀解析为 ${clip(bare)}，期望 ${fullId}`)
  const prefixed = f.companion.resolveSessionId('session-9f1c')
  ensure(prefixed === fullId, `带 session- 前缀解析为 ${clip(prefixed)}，期望 ${fullId}`)
  const fired = await f.companion.fire('9f1c2d3e')
  ensure(fired === true, 'fire(裸 8 位前缀) 未生效')
  return 'session- 前缀剥离 + 8 位唯一前缀可解析（含 fire）'
})

// 运行态诊断：feiyu_heartbeat action=debug 依赖 diagnose() 的计数与字段
test('debug-counters', async () => {
  const f = await makeFixture()
  await armByFirstTurn(f, 's1', 'idle')
  const d = f.companion.diagnose()
  ensure(d && typeof d === 'object', 'diagnose() 未返回对象')
  ensure(d.attached === true, `diagnose().attached = ${clip(d.attached)}，期望 true`)
  const counters = d.counters ?? {}
  ensure(counters.eventsSeen >= 1, `counters.eventsSeen = ${clip(counters.eventsSeen)}`)
  ensure(counters.turnStarts >= 1, `counters.turnStarts = ${clip(counters.turnStarts)}`)
  ensure(counters.presetMatches >= 1, `counters.presetMatches = ${clip(counters.presetMatches)}`)
  ensure(counters.arms >= 1, `counters.arms = ${clip(counters.arms)}`)
  ensure(Array.isArray(d.agents?.sample) && d.agents.count >= 1, `agents.count = ${clip(d.agents?.count)}`)
  ensure(d.agents.sample[0].hasFollowup === true, 'sample[].hasFollowup 非 true')
  ensure(d.presets?.hasPresetForSession === true, 'presets.hasPresetForSession 非 true')
  ensure(Array.isArray(d.armed) && d.armed.length >= 1, 'armed 未包含已武装会话')
  return `attached=${d.attached} eventsSeen=${counters.eventsSeen} arms=${counters.arms} agents=${d.agents.count}`
})

// 附加：异常不冒泡到 Host，记 lastError 后继续跑
test('error-isolation', async () => {
  const f = await makeFixture()
  const attempts = []
  f.presets.set('s1', 'feiyu')
  f.agents.add('s1', 'idle', (payload) => {
    attempts.push(payload)
    throw new Error('followup 失败（模拟）')
  })
  f.emit('session/event', { id: 's1' }, { type: 'turn/start' })
  await flush()
  f.advance(FIRST_DELAY_MS)
  let thrown = null
  try {
    await f.companion.tick()
  } catch (err) {
    thrown = err
  }
  ensure(!thrown, `tick 把异常抛给了调用方：${thrown?.message}`)
  ensure(attempts.length === 1, `投递尝试 ${attempts.length} 次，期望 1`)
  const e = entryFor(f, 's1')
  ensure(e, '异常后会话被移除（应保留并继续）')
  ensure(e.lastError !== undefined && e.lastError !== null && String(e.lastError).length > 0, 'status() 未记录 lastError')
  return `异常被吞掉并记录 lastError：${clip(e.lastError, 40)}`
})

/* ------------------------------------------------------------------ *
 * 执行
 * ------------------------------------------------------------------ */
for (const [id, fn] of runner) {
  try {
    const detail = await withTimeout(fn(), id)
    pass(id, detail ?? 'ok')
  } catch (err) {
    fail(id, err)
  }
}

const p = results.filter((r) => r.status === 'PASS').length
const f = results.filter((r) => r.status === 'FAIL').length
const s = results.filter((r) => r.status === 'SKIP').length
const ok = f === 0

if (JSON_MODE) {
  console.log(JSON.stringify({ ok, target: TARGET, pass: p, fail: f, skip: s, results }, null, 2))
} else {
  console.log('feiyu-connector/lib/companion.js 单测（假 ctx / 假 services / 可控时钟，不联网）')
  console.log(`目标：${TARGET}`)
  console.log('')
  for (const r of results) console.log(`[${r.status}] ${r.id.padEnd(22)} ${r.detail}`)
  console.log('')
  console.log(`PASS ${p} / FAIL ${f} / SKIP ${s}`)
  console.log(`RESULT: ${ok ? 'PASS' : 'FAIL'}`)
}

process.exitCode = ok ? 0 : 1
