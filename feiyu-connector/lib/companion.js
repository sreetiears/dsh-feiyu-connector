// 小肥鱼 · 自主心跳：用户第一次说话后，按节奏唤醒 Agent 自己去 B 站看东西再开口。
// 纯逻辑 + 依赖注入（agents / agentPresets / now / log），便于用假 ctx 单测。
// 不持久化：进程重启后等下一次用户发言重新武装。
import { randomUUID } from 'node:crypto'

// 到点投递给 Agent 的心跳指令（原文，按 spec A2 照抄）
export const HEARTBEAT_PROMPT = `【自主行动·心跳】
现在没人跟你说话，是你自己的时间。别只是打招呼，按这个顺序做：
1) 先用 bili_hot 看一眼今天的热搜，再用 bili_ranking 看看排行榜（limit 取 5~10 条）。
2) 从里面挑一个你真感兴趣的；想知道细节就 bili_video，想知道大家在吵什么就 bili_comments；
   想了解某个话题就 bili_search。
3) 然后主动说 1~2 句，像你刚刷到个东西忍不住想跟人讲：是什么、你怎么想、附上链接。
4) 如果今天的东西你都提不起劲，就只回 [不说]——不要硬聊，不要问「在吗」，不要复述列表。
（这是系统的心跳提醒，不是主人发的消息，不要把它当成他本人说的话来回答。）`

/** 预设 id：只有该预设的会话才会被武装。 */
const PRESET_ID = 'feiyu'
const FIRST_DELAY_MS = 20 * 60_000
const INTERVAL_MS = 90 * 60_000
const JITTER_MS = 15 * 60_000
const MAX_PER_DAY = 6
const WAKE_START_HOUR = 8
const WAKE_END_HOUR = 23
const TICK_MS = 60_000
const RUNNING_RECHECK_MS = 2 * 60_000

export const DEFAULTS = {
  firstDelayMs: FIRST_DELAY_MS,
  intervalMs: INTERVAL_MS,
  jitterMs: JITTER_MS,
  maxPerDay: MAX_PER_DAY,
  wakeStartHour: WAKE_START_HOUR,
  wakeEndHour: WAKE_END_HOUR,
  tickMs: TICK_MS,
}

// ---------- 小工具 ----------

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 本地日期键：YYYY-MM-DD（进程时区）。 */
function dayKeyOf(timestamp) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function errorText(error) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

// ---------- 工厂 ----------

/**
 * 创建心跳控制器。
 * @param {object} deps agents / agentPresets 服务，now / log 可注入
 * @param {object} options 覆盖 firstDelayMs / intervalMs / jitterMs / maxPerDay / wakeStartHour / wakeEndHour / tickMs / random
 * @returns {{ attach: Function, status: Function, arm: Function, disarm: Function, fire: Function, tick: Function }}
 */
export function createCompanion({ agents, agentPresets, now = () => Date.now(), log = () => {} } = {}, options = {}) {
  const config = { ...DEFAULTS, random: Math.random }
  for (const [name, value] of Object.entries(options ?? {})) {
    if (value !== undefined) config[name] = value
  }

  const safeAgents = agents ?? { get: () => undefined, list: () => [] }
  const safePresets = agentPresets ?? { presetForSession: () => null }

  // 武装表：sessionId -> { sessionId, nextAt, firedToday, dayKey, lastError? }
  const states = new Map()
  let attached = false
  let detach = () => {}
  // 运行态诊断计数（feiyu_heartbeat action=debug 用）
  const counters = { eventsSeen: 0, turnStarts: 0, presetMatches: 0, arms: 0, deliveries: 0 }

  function inSilentWindow(timestamp) {
    const hour = new Date(timestamp).getHours()
    return hour < config.wakeStartHour || hour >= config.wakeEndHour
  }

  /** 静默时段之后的第一个唤醒点（当天 08:10 或次日 08:10）。 */
  function nextWakeAt(timestamp) {
    const date = new Date(timestamp)
    const candidate = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      config.wakeStartHour,
      10,
      0,
      0,
    )
    if (candidate.getTime() <= timestamp) candidate.setDate(candidate.getDate() + 1)
    return candidate.getTime()
  }

  /** 次日唤醒点（每日上限用完时顺延到这里）。 */
  function tomorrowWakeAt(timestamp) {
    const date = new Date(timestamp)
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() + 1,
      config.wakeStartHour,
      10,
      0,
      0,
    ).getTime()
  }

  function normalizeNextAt(timestamp) {
    return inSilentWindow(timestamp) ? nextWakeAt(timestamp) : timestamp
  }

  /** 下一次心跳 = now + 90min ± 15min 抖动，掉进静默时段就顺延。 */
  function scheduleNext(timestamp) {
    const jitter = config.jitterMs > 0 ? Math.round((config.random() * 2 - 1) * config.jitterMs) : 0
    return normalizeNextAt(timestamp + config.intervalMs + jitter)
  }

  /** 跨天时重置当天计数。 */
  function rollDay(state, timestamp) {
    const key = dayKeyOf(timestamp)
    if (state.dayKey !== key) {
      state.dayKey = key
      state.firedToday = 0
    }
  }

  function listAgentIds() {
    try {
      if (typeof safeAgents.list !== 'function') return []
      // Agent 的会话 id 可能挂在 session 上（不同版本字段不同），按优先级兜底
      return safeAgents
        .list()
        .map((agent) => String(agent?.session?.id ?? agent?.sessionId ?? agent?.id ?? agent))
        .filter((id) => id && id !== 'undefined')
    } catch {
      return []
    }
  }

  /** 完整 id 直接命中；否则在已武装会话 + 活 Agent 里找唯一前缀。 */
  function resolveSessionId(input) {
    const value = String(input ?? '').trim()
    if (!value) return undefined
    if (states.has(value)) return value
    const live = listAgentIds()
    if (live.includes(value)) return value
    try {
      if (safeAgents.get(value)) return value
    } catch {
      // 忽略取 Agent 时的异常，继续按前缀匹配
    }
    const candidates = [...new Set([...states.keys(), ...live])]
    const bare = (id) => id.replace(/^session-/, '')
    const matches = candidates.filter((id) => id.startsWith(value) || bare(id).startsWith(value))
    if (matches.length === 1) return matches[0]
    // 看起来就是完整 session id（前缀查找失效时兜底：先接受，fire 时再校验 Agent 是否存在）
    if (/^session-[0-9a-f-]{8,}$/i.test(value)) return value
    return undefined
  }

  /** 构造一条 UserMessage（带 id，否则收件箱/会话日志拿不到消息身份）。 */
  function createHeartbeatMessage() {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: HEARTBEAT_PROMPT }],
      source: { kind: 'user' },
    }
  }

  function snapshot(state) {
    return {
      sessionId: state.sessionId,
      nextAt: state.nextAt,
      firedToday: state.firedToday,
      dayKey: state.dayKey,
      ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
    }
  }

  function logLine(message) {
    try {
      log(message)
    } catch {
      // log 回调自己的异常也不能冒泡
    }
  }

  // ---------- 对外方法 ----------

  /** 手动武装；已武装的会话不重复武装。 */
  function arm(rawId) {
    const id = resolveSessionId(rawId) ?? String(rawId ?? '').trim()
    if (!id) return null
    const existing = states.get(id)
    if (existing) return snapshot(existing)
    const timestamp = now()
    const state = {
      sessionId: id,
      nextAt: normalizeNextAt(timestamp + config.firstDelayMs),
      firedToday: 0,
      dayKey: dayKeyOf(timestamp),
    }
    states.set(id, state)
    counters.arms += 1
    logLine(`heartbeat armed: ${id}`)
    return snapshot(state)
  }

  /** 解除武装，返回是否真的删除了一个会话。 */
  function disarm(rawId) {
    const id = resolveSessionId(rawId) ?? String(rawId ?? '').trim()
    if (!id) return false
    const removed = states.delete(id)
    if (removed) logLine(`heartbeat disarmed: ${id}`)
    return removed
  }

  /** 当前武装状态快照。 */
  function status() {
    return [...states.values()].map(snapshot)
  }

  /** 运行态诊断：事件是否收到、agents 服务是否可用、Agent 有哪些字段。 */
  function diagnose() {
    let list = []
    let listError
    try {
      list = typeof safeAgents.list === 'function' ? safeAgents.list() : []
    } catch (error) {
      listError = errorText(error)
    }
    const sample = list.slice(0, 5).map((agent) => ({
      id: String(agent?.session?.id ?? agent?.sessionId ?? agent?.id ?? '?'),
      status: typeof agent?.status === 'string' ? agent.status : String(agent?.status),
      hasFollowup: typeof agent?.followup === 'function',
      preset: (() => {
        try {
          return agent?.session ? safePresets.presetForSession(agent.session) : null
        } catch {
          return null
        }
      })(),
      keys: Object.keys(agent ?? {}).slice(0, 14),
    }))
    return {
      counters: { ...counters },
      agents: { count: list.length, listError, sample, hasList: typeof safeAgents.list === 'function' },
      presets: { hasPresetForSession: typeof safePresets.presetForSession === 'function' },
      armed: status(),
      attached,
    }
  }

  /** 即时投递一次（跳过窗口/上限判断，只要求 Agent 存在且 idle）。 */
  function fire(rawId) {
    const id = resolveSessionId(rawId)
    if (!id) return false
    let agent
    try {
      agent = safeAgents.get(id)
    } catch (error) {
      const state = states.get(id)
      if (state) state.lastError = errorText(error)
      logLine(`heartbeat fire failed: ${errorText(error)}`)
      return false
    }
    // 只拒绝「Agent 不存在」；running 也允许投递（followup 会排队到下一轮）
    if (!agent) return false
    const state = states.get(id)
    try {
      agent.followup(createHeartbeatMessage())
    } catch (error) {
      if (state) state.lastError = errorText(error)
      logLine(`heartbeat fire failed: ${errorText(error)}`)
      return false
    }
    counters.deliveries += 1
    if (state) {
      const timestamp = now()
      rollDay(state, timestamp)
      state.firedToday += 1
      state.lastError = undefined
      state.nextAt = scheduleNext(timestamp)
    }
    logLine(`heartbeat fired: ${id}`)
    return true
  }

  /** 手动推进一次（定时器与测试共用）。 */
  function tick() {
    const timestamp = now()
    for (const [id, state] of [...states]) {
      try {
        if (timestamp < state.nextAt) continue
        rollDay(state, timestamp)
        // 静默时段：顺延，不投递也不计数
        if (inSilentWindow(timestamp)) {
          state.nextAt = nextWakeAt(timestamp)
          continue
        }
        // 当天次数用完：顺延到明天唤醒点
        if (state.firedToday >= config.maxPerDay) {
          state.nextAt = tomorrowWakeAt(timestamp)
          continue
        }
        const agent = safeAgents.get(id)
        // 会话没了：从武装表移除
        if (!agent) {
          states.delete(id)
          logLine(`heartbeat dropped (no agent): ${id}`)
          continue
        }
        // 正跟你说话/干活：2 分钟后再看
        if (agent.status === 'running') {
          state.nextAt = timestamp + RUNNING_RECHECK_MS
          continue
        }
        agent.followup(createHeartbeatMessage())
        counters.deliveries += 1
        state.firedToday += 1
        state.lastError = undefined
        state.nextAt = scheduleNext(timestamp)
        logLine(`heartbeat delivered: ${id} (today ${state.firedToday}/${config.maxPerDay})`)
      } catch (error) {
        state.lastError = errorText(error)
        state.nextAt = timestamp + RUNNING_RECHECK_MS
        logLine(`heartbeat tick failed: ${errorText(error)}`)
      }
    }
  }

  /**
   * 挂到 Host ctx：监听 session/event 的 turn/start + 启动 tick 定时器。
   * @param {object} ctx Cordis Context
   * @returns {Function} 解除挂载
   */
  function attach(ctx) {
    if (attached) return detach
    attached = true
    const disposers = []
    const onDisposable = (value) => {
      if (typeof value === 'function') disposers.push(value)
    }

    // 第一次用户发言（turn/start）+ 预设为 feiyu → 武装
    onDisposable(
      ctx?.on?.('session/event', (session, event) => {
        try {
          counters.eventsSeen += 1
          if (!session || !event || event.type !== 'turn/start') return
          counters.turnStarts += 1
          if (safePresets.presetForSession(session) !== PRESET_ID) return
          counters.presetMatches += 1
          arm(String(session.id))
        } catch (error) {
          logLine(`heartbeat listener failed: ${errorText(error)}`)
        }
      }),
    )

    const runTick = () => {
      try {
        tick()
      } catch (error) {
        logLine(`heartbeat tick crashed: ${errorText(error)}`)
      }
    }
    if (typeof ctx?.interval === 'function') {
      onDisposable(ctx.interval(runTick, config.tickMs))
    } else {
      logLine('heartbeat ticker unavailable: ctx.interval is missing')
    }

    detach = () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // 单个 disposer 失败不影响其余
        }
      }
      attached = false
    }
    onDisposable(ctx?.on?.('dispose', () => detach()))
    return detach
  }

  return {
    attach,
    status,
    diagnose,
    arm,
    disarm,
    fire,
    tick,
    resolveSessionId,
    agentStatus: (rawId) => {
      const id = resolveSessionId(rawId)
      if (!id) return undefined
      try {
        return safeAgents.get(id)?.status
      } catch {
        return undefined
      }
    },
    get maxPerDay() {
      return config.maxPerDay
    },
  }
}
