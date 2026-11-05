// feiyu-connector 插件入口：向 Host 全局注册 5 个 B 站只读工具 + 1 个心跳调试工具，
// 并在 apply 里挂上「小肥鱼」会话的自主心跳（用户第一次说话后到点自己去 B 站看东西）。
// 注意：这里刻意不用静态 import 拉 @deepseek-ai/dsh-tools —— 本机 profile 里该包可能是
// 旧版本（0.1.5-rc.x），解析失败会让整个插件不激活；动态导入 + 恒等兜底更稳。
import {
  hotSearch,
  ranking,
  searchVideos,
  videoDetail,
  videoComments,
} from './lib/bili.js'
import { createCompanion } from './lib/companion.js'

let defineTool = (definition) => definition
try {
  const toolsModule = await import('@deepseek-ai/dsh-tools')
  if (typeof toolsModule.defineTool === 'function') defineTool = toolsModule.defineTool
} catch {
  // 运行时不提供该包时保持兜底实现：defineTool 只是原样返回定义对象
}

export const name = 'feiyu-connector'
export const inject = ['tools', 'agents', 'agentPresets', 'timer']

// ---------- 小工具 ----------

const textContent = (value) => [{ type: 'text', text: value }]

function formatCount(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return '0'
  if (number >= 100_000_000) return `${(number / 100_000_000).toFixed(1).replace(/\.0$/, '')}亿`
  if (number >= 10_000) return `${(number / 10_000).toFixed(1).replace(/\.0$/, '')}万`
  return String(number)
}

function formatDate(seconds) {
  const number = Number(seconds)
  if (!Number.isFinite(number) || number <= 0) return ''
  const date = new Date(number * 1000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// 统一执行入口：把 exec.signal 透传给 HTTP 客户端，异常转成框架能展示的 Error
async function runRead(fn, args, exec) {
  try {
    return await fn({ ...args, signal: exec?.signal })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'B 站暂时用不了'
    throw new Error(message)
  }
}

// ---------- 工具定义 ----------

const hotTool = {
  name: 'bili_hot',
  description: '获取 B 站当前的全站热搜词；想聊今天什么火、有什么热点时先用它。',
  parameters: {
    keyword: { type: 'string', description: '可选：只保留包含该词的热搜词，忽略大小写' },
    limit: { type: 'integer', description: '返回条数，1-50，默认 10' },
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              keyword: { type: 'string' },
              url: { type: 'string' },
              hot: { type: 'number' },
            },
            required: ['keyword', 'url'],
          },
        },
      },
    },
    render: (_args, value) => {
      const keywords = value?.keywords ?? []
      if (!keywords.length) return textContent('没有匹配的热搜词')
      const lines = keywords.map(
        (item) => `- ${item.keyword}${item.hot ? `（热度 ${formatCount(item.hot)}）` : ''} ${item.url}`,
      )
      return textContent(lines.join('\n'))
    },
  },
  async execute(args, exec) {
    return runRead(hotSearch, args, exec)
  },
}

const rankingTool = {
  name: 'bili_ranking',
  description: '获取 B 站排行榜上的热门视频，用于聊最近大家都在看什么。',
  parameters: {
    rid: {
      type: 'integer',
      description: '分区 id：0=全站（默认）、1=动画、3=音乐、4=游戏、5=娱乐、36=科技、188=数码',
    },
    limit: { type: 'integer', description: '返回条数，1-50，默认 20' },
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              bvid: { type: 'string' },
              title: { type: 'string' },
              owner: { type: 'string' },
              view: { type: 'number' },
              like: { type: 'number' },
              duration: { type: 'string' },
              videoUrl: { type: 'string' },
              cover: { type: 'string' },
            },
            required: ['bvid', 'title', 'owner', 'videoUrl'],
          },
        },
      },
    },
    render: (_args, value) => {
      const items = value?.items ?? []
      if (!items.length) return textContent('排行榜暂时是空的')
      const lines = items.map(
        (item, index) =>
          `${index + 1}. ${item.title} — ${item.owner}｜${formatCount(item.view)}播放｜${item.duration}｜${item.videoUrl}`,
      )
      return textContent(lines.join('\n'))
    },
  },
  async execute(args, exec) {
    return runRead(ranking, args, exec)
  },
}

const searchTool = {
  name: 'bili_search',
  description: '按关键词搜索 B 站视频；用户想找具体内容或某个 UP 主的作品时使用。',
  parameters: {
    keyword: { type: 'string', required: true, description: '搜索关键词' },
    order: {
      type: 'string',
      description: '排序：totalrank=综合（默认）、click=最多播放、pubdate=最新发布、dm=最多弹幕、stow=最多收藏',
    },
    page: { type: 'integer', description: '页码，从 1 开始，默认 1' },
    limit: { type: 'integer', description: '返回条数，1-30，默认 20' },
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        total: { type: 'number' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              bvid: { type: 'string' },
              title: { type: 'string' },
              owner: { type: 'string' },
              view: { type: 'number' },
              like: { type: 'number' },
              duration: { type: 'string' },
              description: { type: 'string' },
              videoUrl: { type: 'string' },
            },
            required: ['bvid', 'title', 'owner', 'videoUrl'],
          },
        },
      },
    },
    render: (_args, value) => {
      const items = value?.items ?? []
      if (!items.length) return textContent('没搜到相关视频')
      const header = `共 ${formatCount(value?.total)} 个结果，显示 ${items.length} 条`
      const lines = items.map(
        (item) =>
          `- ${item.title} — ${item.owner}｜${formatCount(item.view)}播放｜${item.duration}｜${item.videoUrl}`,
      )
      return textContent([header, ...lines].join('\n'))
    },
  },
  async execute(args, exec) {
    return runRead(searchVideos, args, exec)
  },
}

const videoTool = {
  name: 'bili_video',
  description: '查看单个 B 站视频的详情（简介、UP 主、播放点赞等数据）；想聊某个具体视频时用。',
  parameters: {
    bvid: { type: 'string', required: true, description: '视频 BV 号，如 BV1xx411c7mD；也可直接传视频链接' },
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        bvid: { type: 'string' },
        aid: { type: 'number' },
        title: { type: 'string' },
        owner: { type: 'string' },
        view: { type: 'number' },
        like: { type: 'number' },
        coin: { type: 'number' },
        favorite: { type: 'number' },
        share: { type: 'number' },
        duration: { type: 'string' },
        pubdate: { type: 'number' },
        description: { type: 'string' },
        cover: { type: 'string' },
        videoUrl: { type: 'string' },
      },
      required: ['bvid', 'title', 'owner', 'videoUrl'],
    },
    render: (_args, value) => {
      if (!value?.bvid) return textContent('视频不存在或已失效')
      const stats = [
        `播放 ${formatCount(value.view)}`,
        `点赞 ${formatCount(value.like)}`,
        `投币 ${formatCount(value.coin)}`,
        `收藏 ${formatCount(value.favorite)}`,
        `分享 ${formatCount(value.share)}`,
        `时长 ${value.duration}`,
      ]
      const published = formatDate(value.pubdate)
      const lines = [`${value.title} — ${value.owner}`, stats.join('｜')]
      if (published) lines.push(`发布于 ${published}`)
      if (value.description) lines.push(value.description)
      lines.push(value.videoUrl)
      return textContent(lines.join('\n'))
    },
  },
  async execute(args, exec) {
    return runRead(videoDetail, args, exec)
  },
}

const commentsTool = {
  name: 'bili_comments',
  description: '读取某个 B 站视频下的评论，用来看大家在聊什么。',
  parameters: {
    bvid: { type: 'string', required: true, description: '视频 BV 号，如 BV1xx411c7mD；也可直接传视频链接' },
    limit: { type: 'integer', description: '返回条数，1-50，默认 20' },
    sort: { type: 'string', description: "排序：hot=按热度（默认），new=按时间" },
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        count: { type: 'number' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              user: { type: 'string' },
              message: { type: 'string' },
              like: { type: 'number' },
              time: { type: 'number' },
              replies: { type: 'number' },
            },
            required: ['user', 'message'],
          },
        },
      },
    },
    render: (_args, value) => {
      const items = value?.items ?? []
      if (!items.length) return textContent('这个视频还没有评论')
      const header = `共 ${formatCount(value?.count)} 条评论，显示 ${items.length} 条`
      const lines = items.map((item) => {
        const suffix = item.replies > 0 ? `（${item.replies} 条回复）` : ''
        return `- ${item.user}（${formatCount(item.like)} 赞）：${item.message}${suffix}`
      })
      return textContent([header, ...lines].join('\n'))
    },
  },
  async execute(args, exec) {
    return runRead(videoComments, args, exec)
  },
}

// ---------- 心跳（自主行动） ----------

const HEARTBEAT_ACTIONS = ['status', 'debug', 'arm', 'disarm', 'fire']

function shortSessionId(id) {
  return String(id ?? '').slice(0, 8)
}

// 本地时间 HH:MM
function clockText(timestamp) {
  const date = new Date(Number(timestamp) || 0)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function heartbeatDefinition(companion, initError) {
  const reply = (action, ok, lines) => ({ action, ok, lines })

  return {
    name: 'feiyu_heartbeat',
    description: '调试「小肥鱼」的自主心跳：看哪些会话到点会自己去看 B 站，或手动武装、解除、立刻触发一次。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'status=列出已武装会话；debug=运行态诊断；arm=武装；disarm=解除；fire=立即投递一次心跳',
      },
      session_id: {
        type: 'string',
        description: 'arm / disarm / fire 必填：会话完整 id，或能唯一匹配的前 8 位前缀',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          ok: { type: 'boolean' },
          lines: { type: 'array', items: { type: 'string' } },
        },
        required: ['action', 'ok', 'lines'],
      },
      render: (_args, value) => textContent((value?.lines ?? []).join('\n') || '（没有输出）'),
    },
    async execute(args) {
      const action = String(args?.action ?? '').trim().toLowerCase()
      if (!HEARTBEAT_ACTIONS.includes(action)) {
        throw new Error('action 只能是 status / debug / arm / disarm / fire')
      }
      if (!companion) {
        return reply(action, false, [`心跳模块没有启动：${initError ?? '未知原因'}`])
      }

      if (action === 'debug') {
        const info = companion.diagnose()
        const lines = [
          `attached=${info.attached}`,
          `eventsSeen=${info.counters.eventsSeen} turnStarts=${info.counters.turnStarts} presetMatches=${info.counters.presetMatches} arms=${info.counters.arms} deliveries=${info.counters.deliveries}`,
          `agents=${info.agents.count} hasList=${info.agents.hasList}${info.agents.listError ? ` listError=${info.agents.listError}` : ''}`,
          `presets=${info.presets.hasPresetForSession}`,
          ...info.agents.sample.map(
            (agent) =>
              `agent ${shortSessionId(agent.id)} status=${agent.status} preset=${agent.preset ?? 'null'} followup=${agent.hasFollowup} keys=${agent.keys.join('|')}`,
          ),
          `armed=${info.armed.length}`,
        ]
        return reply('debug', true, lines)
      }

      if (action === 'status') {
        const entries = companion.status()
        if (!entries.length) return reply('status', true, ['当前没有会话在跑心跳'])
        const lines = entries.map(
          (entry) =>
            `- ${shortSessionId(entry.sessionId)} next=${clockText(entry.nextAt)} 今日已发 ${entry.firedToday}/${companion.maxPerDay}`,
        )
        return reply('status', true, lines)
      }

      const input = String(args?.session_id ?? '').trim()
      if (!input) throw new Error('session_id 不能为空')

      if (action === 'fire') {
        const id = companion.resolveSessionId(input)
        if (!id) return reply('fire', false, ['未投递（找不到该会话）'])
        const agentState = companion.agentStatus(id)
        if (agentState === undefined) return reply('fire', false, ['未投递（找不到该会话）'])
        const ok = companion.fire(id)
        if (!ok) return reply('fire', false, ['未投递（投递失败）'])
        return reply('fire', true, [agentState === 'running' ? '已投递（agent 正在跑，会在下一轮处理）' : '已投递'])
      }

      const id = companion.resolveSessionId(input)
      if (!id) return reply(action, false, ['未执行（找不到该会话）'])

      if (action === 'disarm') {
        const removed = companion.disarm(id)
        return removed
          ? reply('disarm', true, [`已解除 ${shortSessionId(id)} 的心跳`])
          : reply('disarm', false, [`该会话本来就没跑心跳 ${shortSessionId(id)}`])
      }

      const existed = companion.status().some((entry) => entry.sessionId === id)
      const entry = companion.arm(id)
      if (!entry) return reply('arm', false, ['未执行（找不到该会话）'])
      const prefix = existed ? `已武装（本来就在跑）${shortSessionId(id)}` : `已武装 ${shortSessionId(id)}`
      return reply('arm', true, [`${prefix}，下次 ${clockText(entry.nextAt)}`])
    },
  }
}

// ---------- 注册 ----------

export function apply(ctx) {
  for (const definition of [hotTool, rankingTool, searchTool, videoTool, commentsTool]) {
    ctx.tools.register(defineTool(definition))
  }

  // 心跳依赖 agents / agentPresets；服务缺失时只跳过心跳，不影响 B 站工具
  let companion = null
  let companionInitError = null
  try {
    if (!ctx.agents || !ctx.agentPresets) {
      throw new Error(
        `服务缺失 agents=${typeof ctx.agents} agentPresets=${typeof ctx.agentPresets} ` +
          `keys=${Object.keys(ctx).filter((k) => /agent|preset/i.test(k)).join(',') || 'none'}`,
      )
    }
    companion = createCompanion({ agents: ctx.agents, agentPresets: ctx.agentPresets })
    companion.attach(ctx)
  } catch (error) {
    companion = null
    companionInitError = error instanceof Error ? error.message : String(error)
  }
  ctx.tools.register(defineTool(heartbeatDefinition(companion, companionInitError)))
}
