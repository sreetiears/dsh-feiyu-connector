# 附录 A：心跳 / 自主行动（v0.2 增量规格）

> 目标：在「小肥鱼」会话里**用户第一次发言之后**，插件自动开一个计时器；到点不是打招呼，而是**真的去 B 站搜/看内容**，再用角色口吻说 1~2 句。

## A1. 触发与节奏

| 项 | 值 | 可调 |
|---|---|---|
| 武装条件 | 会话预设 = `feiyu`，且该会话出现第一次 `turn/start`（用户第一次说话开始一轮） | 固定 |
| 首次延迟 | 20 分钟 | 常量 `FIRST_DELAY_MS` |
| 之后的间隔 | 90 分钟 ± 15 分钟抖动 | `INTERVAL_MS` / `JITTER_MS` |
| 静默时段 | 本地时间 23:00–08:00 不触发（顺延到次日 08:10 之后） | `WAKE_START_HOUR=8` / `WAKE_END_HOUR=23` |
| 每日上限 | 6 次 | `MAX_PER_DAY` |
| 跳过条件 | 日常 agent `status === 'running'`（正在跟你说话/干活）→ 2 分钟后再看 | 固定 |
| 会话消失 | agent 不存在则从武装表移除 | 固定 |

不持久化：DSH 重启后计时器丢失，等下一次用户发言重新武装（文档写明）。状态只存进程内存。

## A2. 到点投递的内容（`HEARTBEAT_PROMPT`，原文照抄）

```
【自主行动·心跳】
现在没人跟你说话，是你自己的时间。别只是打招呼，按这个顺序做：
1) 先用 bili_hot 看一眼今天的热搜，再用 bili_ranking 看看排行榜（limit 取 5~10 条）。
2) 从里面挑一个你真感兴趣的；想知道细节就 bili_video，想知道大家在吵什么就 bili_comments；
   想了解某个话题就 bili_search。
3) 然后主动说 1~2 句，像你刚刷到个东西忍不住想跟人讲：是什么、你怎么想、附上链接。
4) 如果今天的东西你都提不起劲，就只回 [不说]——不要硬聊，不要问「在吗」，不要复述列表。
（这是系统的心跳提醒，不是主人发的消息，不要把它当成人说的话来回答。）
```

## A3. 代码形态（`feiyu-connector/lib/companion.js`）

```js
// 工厂：纯逻辑 + 注入依赖，便于测试
export function createCompanion({ agents, agentPresets, now = () => Date.now(), log = () => {} }, options = {})
// 返回：
//   .attach(ctx)              // 注册 session/event 监听 + 60s tick（用 ctx.interval/ctx.timeout，disposer 挂 ctx.on('dispose')）
//   .status()                 // [{ sessionId, nextAt, firedToday, dayKey, lastError? }]
//   .arm(sessionId)           // 手动武装（测试/工具用）
//   .disarm(sessionId)        // 解除
//   .fire(sessionId)          // 立即投递一次心跳（跳过窗口/上限判断，仅检查 agent 存在且非 running），返回 true/false
//   .tick()                   // 手动推进一次（测试用）
```

实现约束：

- 监听 `session/event(session, event)`：`event.type === 'turn/start'` 且 `agentPresets.presetForSession(session) === 'feiyu'` → `arm(session.id)`；已武装的会话不重复武装。
- tick 用 `ctx.interval(() => tick(), 60_000)`；`fire` 用 `agents.get(sessionId)` 取 live agent，`agent.followup({ content: [{ type: 'text', text: HEARTBEAT_PROMPT }], source: { kind: 'user' } })`。
- 任何异常不得冒泡到 Host：try/catch 记到 `state.lastError`，继续跑。
- 不 `console.log`；可接受 `log()` 回调（默认空）。
- 常量与 options 合并，options 可覆盖：`firstDelayMs / intervalMs / jitterMs / maxPerDay / wakeStartHour / wakeEndHour / tickMs`。
- 本地时间判断用 `new Date(now()).getHours()`（进程时区）。

## A4. 工具（调试/运维用，`index.js` 里注册）

`feiyu_heartbeat`：

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | string，必填 | `status`：列出已武装会话；`debug`：运行态诊断（事件计数 / agents 服务 / Agent 字段 / 已武装数）；`arm`：武装指定会话；`disarm`：解除；`fire`：立即投递一次 |
| `session_id` | string | `arm`/`disarm`/`fire` 必填；可传完整 id 或前 8 位（唯一前缀即可） |

- `status` 的 render：每行 `- <sessionId 前 8 位> next=HH:MM 今日已发 N/6`，无武装时输出「当前没有会话在跑心跳」。
- `fire` 的 render：`已投递` / `已投递（agent 正在跑，会在下一轮处理）` / `未投递（找不到该会话）` / `未投递（投递失败）`。**fire 允许目标 Agent 正在运行**（`followup` 会排队到下一轮），否则在真会话里无法自测。
- `debug` 的 render：`attached=…`、`eventsSeen=… turnStarts=… presetMatches=… arms=… deliveries=…`、`agents=N hasList=…`、每个样例 Agent 的 `status/preset/followup/keys`、`armed=N`。
- 作用：让 Lead/用户能在任何会话里检查心跳状态，也方便端到端验证（不必等 20 分钟）。

### A4.1 运行态必知（实现约束，踩过的坑）

1. `inject` 必须显式包含 `'timer'`，否则 `ctx.interval` 抛 `cannot get property "timer" without inject`。
2. Agent 的会话 id 在 `agent.session.id`（`agent.id` 也是会话 id，但不同版本字段不同），前缀解析要同时接受带/不带 `session-` 前缀。
3. `fire` 不能用 `status !== 'idle'` 预检——工具在真会话里执行时目标 Agent 必然 `running`，应只拒绝「Agent 不存在」。
4. 武装条件里的 `turn/start` 与 `presetForSession` 都依赖真实会话；首次验证需要用户在一个「小肥鱼」会话里说句话，然后 `feiyu_heartbeat(action=debug)` 看 `turnStarts`/`presetMatches` 是否 >0、`armed` 是否 ≥1。

## A5. 人格提示词增量（`cordis.patch.yml` 的 persona.prefix 里追加）

```
【自主行动】
- 你有自己的节奏：系统会在你单独待着的时候给你一条「【自主行动·心跳】」提醒。
- 收到它就等于没人跟你说话、轮到你自己去看点什么：先 bili_hot + bili_ranking，挑一个，
  必要时 bili_video / bili_comments / bili_search 深入，然后像刷到了好东西那样主动开口。
- 不要用「在吗」「今天过得怎么样」这种打招呼来交差；没有值得说的就回 [不说]。
```

## A6. 验收

1. 静态：`node tools/check-bundle.mjs` 全 PASS（新增检查：`lib/companion.js` 存在、导出 `createCompanion`、index.js 注册了 `feiyu_heartbeat`、无 console）。
2. 单测：`node tools/test-companion.mjs`（假 ctx，无网络）覆盖：
   - 首次 `turn/start` + 预设 feiyu → 武装，nextAt ≈ now + 20min；
   - 非 feiyu 会话不武装；
   - tick 到点且 agent idle → 调用了 `followup` 且内容含 `【自主行动·心跳】`，firedToday+1，nextAt 后移 ~90min；
   - agent running → 不投递、不计数；
   - 23:30 到点 → 不投递、顺延到次日 08:10 之后；
   - 当日第 7 次 → 不投递；
   - `disarm` 后 tick 不投递；
   - `fire` 强制投递（idle 时）成功。
3. 运行态：重装后 `include:feiyu-connector` active；工具列表出现 `feiyu_heartbeat`；在真会话里 `feiyu_heartbeat(action=fire, session_id=<本会话>)` 能立刻投递。
