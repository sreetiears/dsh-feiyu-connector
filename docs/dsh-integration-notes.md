# 本机 DSH 集成点调研（MCP / 自定义工具插件 / 人格预设 / 定时主动消息 / 凭据）

> 目标读者：Team Lead。用途：据本文写"X/B站 读写 + 角色卡人设 + 主动对话"方案。
> 所有结论均来自实际读到的源码/配置，附 `路径:行号`。**本次未修改任何配置、未安装依赖、未动 `<DSH_HOME>`。**

## 0. 环境事实（先读，否则会看错版本）

| 事实 | 值 | 证据 |
|---|---|---|
| 运行中的实现 | Desktop 版 `0.2.2-rc.1`，dsh 运行时**打包在 asar 内** | `<DSH_INSTALL>\resources\app.asar\package.json:4`（`@deepseek-ai/dsh-desktop` 0.2.2-rc.1，`dshBuildCommit: c59d10a…`） |
| 实现路径简写 | 下文 `$A` = `<DSH_INSTALL>\resources\app.asar\dsh\node_modules\@deepseek-ai` | 例：`$A/dsh-schedule/lib/index.js` |
| 当前 profile | `desktop`（`DSH_PROFILE=desktop`，`DSH_PROFILE_DIR=<DSH_HOME>\profiles\desktop`） | 本会话环境变量 |
| 配置根 | `<DSH_HOME>`（`DSH_HOME`） | 同上 |
| 陷阱 | `<DSH_HOME>\profiles\node_modules\@deepseek-ai\*` 是**旧 0.1.5-rc.3** 的 npx 缓存 junction，`desktop` profile 目录下没有 `node_modules`，**不是**当前运行的实现 | 该目录 `dsh-schedule/package.json:4` 版本 0.1.5-rc.3；`profiles/desktop/` 只有 4 个文件，见 §1 |
| 复核方法 | `.asar` 内路径：`read` 工具可直接读；`glob`/`grep`/shell 会失败（ripgrep 打不开 asar）。需要批量 grep 时先把 asar 头解析、把目标包抽到工作区（我用 Node 写了个 20 行的 asar 头解析脚本，见文末"复核办法"） | — |

---

## 1. profile 结构 & 新增 plugin 行 / bundle 的确切写法

### 1.1 实际目录结构

`<DSH_HOME>\profiles\` 下有 **两个** profile：`desktop`、`web`（当前用 desktop）。

`profiles/desktop/`：

| 文件 | 作用 |
|---|---|
| `cordis.yml` | profile 根入口，**固定为空数组**。文件头注释明确写着"Edit cordis.patch.yml, not this file"（`:1-4`，内容只有 `[]`） |
| `cordis.patch.yml` | 用户补丁层，最后应用；已含 8 条 id 覆盖（`ui-settings-general`、`agent-default-model`、`llm-pi-ai` 等） |
| `package.json` | 声明 `dsh.profile.bundles`；当前 7 个 bundle：`dsh-base`、`dsh-web-app`、`dsh-experimental-auto-review`、`-agent-team-profile`、`-inspector-profile`、`-tool-worktree`、`-session-search` |
| `pnpm-workspace.yaml` | 由 `plugin_manager` 维护，勿手改 |

对比 `profiles/web/package.json` 多了 `"patchReload": "live"`（desktop 没有此字段）。

### 1.2 组合规则（关键：`config` 是整体替换，不深合并）

来源：skill `cordis-composition-reference` + `$A/dsh-base/cordis.patch.yml:1-13` 的头注释：

- profile 根是空数组 → 按 `package.json` 的 bundle 顺序逐层 patch → 再叠用户 `cordis.patch.yml` → 再叠 `--patch`。
- 每个 patch 是 YAML 数组。`insert: [...]` 追加行；带 `id` 且无 `insert` 则**覆盖该行**，且 `config` **整块替换**。
- 行字段：`id` / `name`（包说明符）/ `config` / `disabled`（可布尔、null、`!!js` 表达式）/ `inject` / `intercept` / `isolate`；`group: true` + `name: cordis:group` 的 `config` 是嵌套行列表。
- `!!js` 只在 `config` 值或 `disabled` 中合法，求值上下文是该插件 ctx。
- 现有例子（用户 patch 覆盖配置）：`profiles/desktop/cordis.patch.yml:8-12` 覆盖 `agent-default-model` 的 provider/model。

### 1.3 两种新增方式

**方式 A（不推荐让 Lead 手改用户文件）**：直接往 `profiles/desktop/cordis.patch.yml` 里加 `insert`。可行但会污染用户补丁、无包边界、不便交付/回滚。

**方式 B（推荐，也是官方 skill 指定的交付形态）**：在**工作区**写一个 bundle 包，用 `plugin_manager install_bundle` 安装。

- 判定标准：`package.json` 里声明 `dsh.bundle.patch` 即是一个 bundle（`$A/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:3`）。
- 安装工具：`plugin_manager`，`action: install_bundle`，`target` = **bundle 包的绝对目录**。它会自己跑依赖安装和 bundle 选择，**不要**自己写 profile 的 `package.json`/`cordis.patch.yml`、不要在 profile 目录跑 pnpm（`host-plugin.md:68-81`、skill SKILL.md）。
- 生效：新 bundle 可通过 HMR 直接激活；**替换**已安装包（换版本/换代码）需要重启 Host 才能加载新模块（`host-plugin.md:83`；`$A/dsh-hmr/README.zh.md:49`）。
- 校验：`plugin_manager list_bundles` / `list_plugins`（看 `enabled`、`fiberPhase`）。

最小 Host-only bundle（无依赖、无构建）：

```json
// my-x-bili/package.json
{
  "name": "@local/my-x-bili",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
  "files": ["index.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
# my-x-bili/cordis.patch.yml
- insert:
    - id: my-x-bili
      name: '@local/my-x-bili'
      config: {}
    # 同一次安装里可以顺带挂一个 MCP server（见 §2）
    - id: mcp-x
      name: '@deepseek-ai/dsh-mcp-client'
      config: { serverName: x, transport: stdio, command: node, args: ['C:/path/x-mcp.mjs'] }
```

> `insert` 里 `name` 为相对路径时，锚点在该 patch 文件旁边（skill `cordis-composition-reference`）。插件包被解析到的位置即 bundle 包自身，安装目录会被链接进 profile 的 `node_modules`。
> 展示元数据（`meta.title`/`meta.description` + `icon`）不是可选项：Plugin Manager / 设置页会读它（`host-plugin.md:29-55`）。

---

## 2. MCP：本机已具备，且配置很轻

### 2.1 涉及两个包（都不是"dsh-mcp-resources 里配 server"）

| 包 | 角色 | 是否已有默认行 |
|---|---|---|
| `@deepseek-ai/dsh-mcp-client` | **一个实例连一台 server**，把远端工具注册进 `ctx.tools` | ❌ 无默认行，必须由你插行 |
| `@deepseek-ai/dsh-mcp-resources` | 共享 3 个资源工具，**无任何配置字段** | ✅ base bundle 已挂 `id: mcp-resources`（`$A/dsh-base/cordis.patch.yml:492-493`） |

### 2.2 `dsh-mcp-client` 的 Config schema（精确字段）

`$A/dsh-mcp-client/lib/index.js:781-801`，两个 union 分支：

```ts
// 分支1：本地进程
{ transport: 'stdio',            // 必填常量
  serverName: string,            // 必填，/^[A-Za-z0-9_-]{1,32}$/（:768），注册作用域内唯一
  command: string,               // 必填
  args?: string[] = [], env?: Record<string,string> = {}, cwd?: string = '',
  toolCallTimeoutMs?: number = 60000, failOnStartupError?: boolean = false,
  maxInstructionBytes?: number = 32768, reconnect?: {enabled,initialDelayMs,maxDelayMs,maxAttempts} }
// 分支2：远端
{ transport: 'streamable-http',
  serverName: string, url: string, headers?: Record<string,string> = {},
  ...同上其余字段 }
```

字段语义表见 `$A/dsh-mcp-client/README.zh.md:55-67`。

### 2.3 加载与暴露为工具

- 每个实例 `apply()` 连接 server、拉工具列表、注册进 `ctx.tools`；公开名固定为 **`mcp__<serverName>__<rawName>`**（`$A/dsh-mcp-client/lib/index.js:748-751`；`README.zh.md:71,75`）。名称是稳定纯函数（有损时补 12 位 hash），所以会话历史/权限规则跨重启仍有效。
- stdio 会 spawn 子进程，**父进程环境被清洗**（credential 形状的变量和 `DSH_*` 被剔除），只保留 `config.env` 显式项（`lib/index.js:21-23,43`）。
- 连接失败默认不阻塞启动，只是工具不出现；`failOnStartupError: true` 才让插件激活失败（`:833`）。
- 作用域：Host 全局挂 = 所有 agent 可见；**插进某个 preset 的 `plugins` 列表 = 只有该 preset 的 agent 可见**（`README.zh.md:127` 关于 agent 作用域复用同名 serverName）。

### 2.4 资源工具（server 有 `resources` 能力时自动多出 3 个工具）

`list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`，最后一个必填 `{server, uri}`（`$A/dsh-mcp-resources/lib/index.js:55-91`）。

### 2.5 结论

**可行，成本最低的一条路。** 给 X/B站 写一个本地 `node` MCP server（stdio），或用社区现成的 X MCP server，然后插一条配置行即可；不需要写 Cordis 插件、不需要碰 profile 源文件。

```yaml
# 最常用：npx 起一个社区 server
- insert:
    - id: mcp-x
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: x
        transport: stdio
        command: npx
        args: ['-y', '@some/x-mcp-server']
        env: { X_BEARER_TOKEN: !!js "''" }   # 建议改为下面的凭据方案，别把密钥写进 patch
        failOnStartupError: false
```

---

## 3. 自定义工具插件（最灵活，推荐用于"写"操作）

### 3.1 插件形态

Cordis 插件 = 一个模块，二选一（`$A/.../references/host-plugin.md:57-64`）：

- `export function apply(ctx, config) {}`（+ 可选 `export const inject = [...]`、`export const Config`）；
- 或默认导出一个 `Service` 子类。

所有资源注册必须放在 `apply` 内并用 `ctx.effect`/`ctx.on` 持有，返回清理函数。

### 3.2 工具注册 API（真实源码）

`$A/dsh-tools/lib/index.js:433-445`：

```js
register(definition, options = {})   // 返回精确的注销 disposer；options.when 可做步骤级条件
```

- 语义注释（`:427-431`）：**"Register globally or in the calling agent scope. Scoped tools shadow globals."**
  → Host bundle 的 `apply()` 里注册 = **全局工具**，被所有 preset 的 agent 继承；在 agent 作用域注册才只影响单个会话。
- `name === 'run_code'` 是保留名（PTC 用），注册会抛错（`:440`）。
- `output` 必填 `{ schema, render }`，`render(args, value) => Content[]`（`:436`）。
- 参数 schema 是统一 DSL：`string/number/integer/boolean/null/array/object/json/oneOf`，字段上可直接写 `required`、`description`（`$A/dsh-tools/README.zh.md:38-64`）。
- 执行器签名：`async execute(args, exec)`；`exec` 上有 `signal`（协作取消）、`agent`、`session`（`$A/dsh-tool-present/lib/index.js:78-80` 的用法）。

### 3.3 定时器（插件内自建轮询/定时）

`ctx.timeout(cb, ms)` / `ctx.interval(cb, ms)`，返回 disposer；句柄挂在当前 fiber 上，插件 dispose 时自动清除。`setTimeout/setInterval` 是已废弃别名（`$A/cordis-plugin-timer/README.md:14-38`）。`timer` 行 base bundle 已挂（`$A/dsh-base/cordis.patch.yml:24-25`），任何插件都能直接用。

### 3.4 完整最小示例（一个能用的 Host bundle，注册 1 个工具）

```js
// my-x-bili/index.js
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'my-x-bili'
export const inject = ['tools', 'credentials']   // credentials 见 §6

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'x_search',
    description: 'Search recent posts on X for a query. Read-only.',
    parameters: {
      query:   { type: 'string', required: true, description: 'Search query' },
      limit:   { type: 'integer', description: 'Max results, 1-50' },
    },
    output: {
      schema: { type: 'array', items: { type: 'object', properties: {
        id: { type: 'string', required: true },
        text: { type: 'string', required: true },
        url: { type: 'string', required: true },
      } } },
      render: (_args, rows) => [{ type: 'text',
        text: rows.map(r => `- ${r.text} (${r.url})`).join('\n') }],
    },
    async execute(args, exec) {
      const bearer = await ctx.credentials.resolve('X_BEARER_TOKEN')
      if (bearer === undefined) throw new Error('X_BEARER_TOKEN is not configured')
      const url = new URL('https://api.x.com/2/tweets/search/recent')
      url.searchParams.set('query', args.query)
      url.searchParams.set('max_results', String(Math.min(Math.max(args.limit ?? 10, 1), 100)))
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${bearer.value}` },
        signal: exec.signal,
      })
      if (!res.ok) throw new Error(`X API ${res.status}: ${(await res.text()).slice(0, 300)}`)
      const json = await res.json()
      return (json.data ?? []).map(t => ({
        id: t.id, text: t.text, url: `https://x.com/i/web/status/${t.id}`,
      }))
    },
  }))
  ctx.on('dispose', () => {})
}
```

配套 `package.json` / `cordis.patch.yml` 见 §1.3；`locale/en.json` + `locale/zh.json` 写 `{"meta":{"title":"...","description":"..."}}`，`icon.svg` 放包内（`host-plugin.md:29-55`）。

### 3.5 HMR 热更新路径（实测规则，别猜）

- profile 监听存在时，**`node_modules` 下（含链接包目标）文件变化 + profile 重新组合**会原地替换已加载插件，无需重启；替换版本加载失败会以 `failed` 报错而不是 `restart-required`（`$A/dsh-hmr/README.zh.md:49`）。
- **新装 bundle** 可经 HMR 直接激活；**替换**已安装包（新模块代）需要重启（`host-plugin.md:83`）。
- HMR 行在 base bundle：`id: hmr`，`root: []`（只监听配置，不监听任意源码根）（`$A/dsh-base/cordis.patch.yml:27-32`）。
- 改插件自己的配置不要手写 profile 文件，用配置编辑器：`ctx.get('configEditor').edit(entry, cur => ({...cur, field}))`（`host-plugin.md:66-77`）。
- 前端（Client 插件）另走 `dsh-client-hmr`，本需求不需要 UI。

### 3.6 结论

**可行，且是"X/B站 写"的首选形态**：一个 Host bundle 里注册多个工具（读/发帖/回复），用 `ctx.credentials.resolve()` 取 token，用 `ctx.interval` 做轮询或交给 §5 的 schedule。缺点是要自己写代码 + 处理 bundle 展示元数据。

---

## 4. 人格 / 预设（角色卡写进哪里）

### 4.1 机制

Agent preset 不是目录里的文件，而是 **bundle patch 声明的一行**：`name: '@deepseek-ai/dsh-agent-preset'`，Loader 行 id 约定 `preset-<id>`，`config` 字段：

```yaml
- insert:
    - id: preset-kiana
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: kiana                 # 必填，小写字母/数字/连字符
        name: Kiana               # 可选，显示名
        description: …            # 可选
        order: 10                 # 可选，名册位置
        plugins:                  # 必填，Cordis 条目列表
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |
                <角色卡全文：身份、语气、说话习惯、边界、称呼方式…>
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
          - id: tool-schedule
            name: '@deepseek-ai/dsh-tool-schedule'
          - id: tool-web
            name: '@deepseek-ai/dsh-tool-web'
          …
```

声明格式来自 skill `editing-cordis-compositions`；内置 4 个 preset 的真实文件在 `$A/dsh-web-app/presets/{standard,ptc,minimal,cordis}.patch.yml`（`standard` 见 `:1-10`）。

### 4.2 角色卡字段 = `dsh-persona` 的 `config.prefix`

`$A/dsh-persona/README.zh.md:32-49`：

| 字段 | 默认 | 含义 |
|---|---|---|
| `prefix` | 必填 | 渲染为 `deployment:persona-prefix` 段落（order 0），**这就是角色卡该写的地方** |
| `suffix` | `''` | `deployment:persona-suffix`（order 10200）；省略/空 = 遮蔽全局后缀 |
| `complete` | `false` | 只用 prefix 作为**完整**系统提示词，其他段落全被抑制（"纯角色扮演、不要工具引导"时才用） |
| `includeRuntimeContext` | `true` | false 时抑制该 agent 的可选运行时上下文（cwd 等必需项仍在） |

- `prefix` 是**模板**：`{{…}}` 在渲染时解析为已注册的提示词变量（`{{model}}` 等在 `standard` 里就这么用：`presets/standard.patch.yml:14`）。
- **不能全局挂 persona**：提示词注册表自己持有未加 scope 的 persona 槽位，全局挂会明确报错——persona 只能出现在 preset 组装内部（`$A/dsh-persona/README.zh.md:28,116`）。
- 想改"部署级"人设（对所有 preset 生效）应改 `system-prompt` 行的 `config.personaPrefix`（`$A/dsh-base/cordis.patch.yml:508-513`，当前是 `''`）。角色卡不建议走这条，会污染所有 agent。

### 4.3 UI 里怎么选

- 设置页 → **Agent preset**：内置/自定义卡片分组、点卡片选择、可设为新任务默认值；每张卡「查看配置」只读展示该 preset 的 YAML（`$A/dsh-client-ui-agent-preset/README.zh.md:28`）。
- 新会话选择器同样列出（受"代码工作工具"开关影响：开=标准/创造/自定义，关=还含 PTC/极简）（同文件 `:30`）。
- **Web 端不创建也不编辑 preset**：创建走"创造模式"（`cordis` preset 下的对话），最终产物就是一个**安装的 bundle**；覆盖内置 preset 用行 id 覆盖并整块重写 `plugins`（`README.zh.md:76`；skill `editing-cordis-compositions`）。

### 4.4 结论

**可行，零风险。** 角色卡 = 一个 bundle：`preset-<id>` 声明 + `dsh-persona.config.prefix` 放全文，再按需要挂 `tool-web`/`tool-schedule`/自定义工具。安装后在设置页选中或设为默认。

---

## 5. 定时主动消息

### 5.1 已有的两个包

| 包 | 角色 | 挂在哪 |
|---|---|---|
| `@deepseek-ai/dsh-schedule` | Host 服务 `ctx.schedule`，任务存储 + 定时器 + 投递 | web-app bundle 已挂 `id: schedule`（`$A/dsh-web-app/cordis.patch.yml:131-136`） |
| `@deepseek-ai/dsh-tool-schedule` | 4 个模型工具 `schedule_create/list/view/edit` | `standard`/`ptc`/`cordis` preset 各自挂（`presets/standard.patch.yml:38-39`） |

本会话（standard preset）已有这些工具，说明本机能力齐备。

### 5.2 "投递"到底是什么（关键机制）

`$A/dsh-schedule/lib/index.js`：

- Host 侧单一 timer 驱动，到点后把任务 `prompt` 作为消息 **`agent.followup(message)`**（`:1366`、`:1391`）塞进目标 Session 收件箱并 flush，从而**唤醒一次模型轮次**。
- `new*` 目标还要 `sessionController.create(...)` 新建 Session（`:1502`）。
- 所以：**到点被投递的是"用户角色的一条指令"，助手消息是模型随后生成的回复**——不是预先写死的 assistant 文本。`README.zh.md:177` 明确"排入 `schedule` 消息，等待 Session flush，然后保存回执"。

### 5.3 target 三态与限制

`$A/dsh-tool-schedule/lib/index.js:384-395,481`：

| 工具值 | 服务端 kind | 行为 |
|---|---|---|
| `this_session` | `session` | 投递到当前 Session（复用已有、未归档、非委派的 Session） |
| `new_once` | `new_once` | 第一次投递时建 Session，之后复用 |
| `new` | `new` | 每次投递新建 Session（有最小间隔，默认 60s） |

硬限制（`$A/dsh-schedule/README.zh.md:279-286`）：

- **宿主必须运行。** 没有重试循环；恢复/创建/入队失败只保留任务并告警。
- **停机只补最近一次**：延迟投递会合并错过的发生时点；`this_session`/`new_once` 还会等上一次跑完。
- 至少一次投递（Session flush 与任务回执是两次独立提交），崩溃后可能重复。
- 管理范围是整个 Host，无任务级授权；委派（subagent）Session 拒绝作为目标。
- 存储：`<DSH_HOME>/storages/schedule.json`（或 SQLite 的 `u_schedule_tasks`）（`README.zh.md:82`）。

### 5.4 插件侧怎么用（两条路）

**(a) 直接用 schedule 服务（推荐，持久化 + UI 可见）**

服务名 `schedule`，`static inject = ['agents','sessions','storageDomain','sessionPersistence']`（`$A/dsh-schedule/lib/index.js:2091-2096`、`:2116`）。API：`create({title,prompt,timing,target?}, actorSessionId?, signal?)`、`edit/list/catalog/view/history/run/deleteInactive`（`README.zh.md:63-77`）。`timing.kind` ∈ `after | at | every | daily | weekly | cron | rrule`（cron 用五字段 + 显式时区；rrule 用 `DTSTART:…\nRRULE:…`）。

```js
export const inject = ['schedule', 'agents']
export function apply(ctx) {
  ctx.interval(() => { /* 轮询 X 新消息，攒到待说内容 */ }, 60_000)
  // 需要时（比如有新消息）
  await ctx.schedule.create({
    title: '主动搭话',
    prompt: '你看到 X 上有人回了你。用角色口吻主动发一条消息给用户。',
    timing: { kind: 'after', after: { seconds: 30 } },   // 具体选择器形状以 README §Recurrence 为准
    target: { kind: 'session', sessionId: <当前会话 id> },
  }, <actorSessionId>)
}
```

> 稳妥做法：**不要自己算 `timing` 结构**，让 Lead 的方案里改用"装一个 bundle，由 Agent 自己调 `schedule_create` 工具"或 UI 的「自动化任务」页创建——跨版本最稳。

**(b) 自己 `ctx.interval` + `agent.followup()`**：完全可控，但不持久化、重启丢任务、UI 看不到，且要自己处理"会话在不在"。

### 5.5 "从 host 侧主动生成一条助手消息"是否可行？

- **不存在**直接 append 一条 assistant 消息的 Service。`dsh-session` 的 `Session.append(type, data)` 在外部只能用 `appendPluginRecord` 写插件记录（`$A/dsh-session/lib/index.js:1524`、`:1297`），`assistant/message` 由 agent loop 在模型返回后提交。
- **可行且官方做法**：`ctx.agents.get(sessionId)` 拿到实时 agent，`agent.followup({content:[{type:'text',text:'…'}], source:{kind:'user'}})` 唤醒一轮（`$A/dsh-agent/README.zh.md:58-70`；`followup` 实现 `$A/dsh-agent-loop/lib/index.js:570`）。另外 `inject()` 只塞上下文不唤醒、`steer()` 提交下一步输入。
- agent 接口完整签名见 `$A/dsh-agent-preset-registry/lib/typert.host.js:284`：`send(message, target, wakeup) / followup / steer / inject / whenIdle / cancel`。

### 5.6 结论

**可行，但语义是"定时唤醒，让模型说"，不是"定时推送一段预置文案"。** 且 **DSH Desktop 退出后不会投递**——想做"不管在不在都能主动发消息"，只能靠外部系统（系统计划任务/服务器）去调 API，而不是 DSH 自身。

---

## 6. 凭据

### 6.1 存储

- 文件：`<DSH_HOME>\.credentials.yaml`（保存在 DSH 家目录）。配置行 `id: credentials` → `@deepseek-ai/dsh-credentials-local`（`$A/dsh-base/cordis.patch.yml:125-126`）。
- 配置项：`path`（默认 `<harness home>/.credentials.yaml`）、`dshHome`、`watch`（默认 true，改文件自动重载）、`debounceMs`（`$A/dsh-credentials-local/README.zh.md:42-47`）。
- 文档结构（版本化 YAML，只有两个键空间）：
  ```yaml
  version: 1
  refs:                       # 环境变量名 → 值
    SOME_API_KEY: sk-…
  records:                    # 插件凭据，键 <owner>/<id>
    llm-pi-ai/openai-codex: { kind: grant, payload: {…} }
    llm-pi-ai/amazon-bedrock: { kind: api-key, env: { AWS_PROFILE: prod } }
  ```
  `refs` 只存放 LLM 服务凭据（与 B 站无关），这里不列举具体键名；对应 `profiles/desktop/cordis.patch.yml` 里 `llm-pi-ai` 行的 `apiKeyEnv`。
- 解析优先级：**存储文件 > 启动时的环境变量快照 > 项目 `.env` > `$DSH_HOME/.env`**（`README.zh.md:71-80`）。

### 6.2 读取 API（插件/工具怎么安全拿 key）

服务名 `credentials`（`$A/dsh-credentials/lib/index.js:111`）：

```js
import { credentialRef } from '@deepseek-ai/dsh-credentials'

const got = await ctx.credentials.resolve(credentialRef('SOME_API_KEY'))
// got: { value, source: 'file'|'env'|… } | undefined        ← :480-497
await ctx.credentials.describe(ref)   // { configured, source?, writable } 绝不含 value  :498-519
await ctx.credentials.set(ref, 'sk-…')  // 空值被拒（要删用 unset）                    :520-524
await ctx.credentials.unset(ref)
// 记录空间（插件自有凭据）：describeRecord / readRecord / listRecords / modifyRecord / deleteRecord  :530-575
```

- `credentialRef` 的品牌化与校验在 `$A/dsh-credentials/lib/index.js:21`。
- 插件里注册 `inject: ['credentials']`（或 `ctx.get('credentials')`）即可；这也就是官方 skill 对"密钥存哪"的指定答案（`host-plugin.md:77`）。
- 文件 `watch: true`：**手改 `.credentials.yaml` 会热重载**，适合先手工加一个第三方 token 应急。

### 6.3 设置 UI 能配什么

- Models 设置页有凭据引导开关（`$A/dsh-client-ui-settings-models/lib/index.js:5`，`Config.credentialOnboarding`），写入的正是托管凭据文档；base patch 注释明确"the Models page writes only the managed document, which is never materialized into the process environment"（`$A/dsh-base/cordis.patch.yml:113-116`）。
- **没有**通用的"任意第三方 token"表单；要新增 `X_BEARER_TOKEN` 这类 ref，用插件调 `ctx.credentials.set()`，或直接编辑 `.credentials.yaml`（会被热重载）。密钥**不要**写进 `cordis.patch.yml`（明文进配置、会进会话与备份）。

### 6.4 安全边界（必须写进方案）

`$A/dsh-credentials-local/README.zh.md:115`：文件只有 OS 属主可读，但 **agent 的工具进程以同一用户身份运行，读它和你读其它文件没区别**——这是"审慎，不是边界"。所以：能读密钥的 agent 也能把密钥打印出来。要真隔离，得把调用放到 agent 之外的服务里（MCP server 进程独立持有密钥，也是一种更好的选择）。

---

## 7. 三条需求：推荐路径 + 本机已具备/缺失

| 需求 | 推荐实现 | 本机是否已具备 | 缺什么 |
|---|---|---|---|
| **X/B站 读**（时间线、搜索、看回复） | ① MCP server（stdio，本地 node 脚本，最省事）；② Host bundle 工具 + `web_fetch` 辅助 | MCP 客户端/资源工具齐备（§2）、`web_search`/`web_fetch` 已挂在 standard（`$A/dsh-tool-web/README.zh.md:2`）、插件 tool API 齐备（§3） | 没有任何 X/B站 官方或内置包；平台 API 的鉴权/限流要自己实现 |
| **X/B站 写**（发帖、回复、点赞） | **Host bundle 插件工具**（唯一能"取密钥 + 加策略门 + 结果可审计"的形态）；用 `tools/pre-execute` 或 `ctx.tools.guard()` 做发帖前确认 | 注册 API/凭据 API/HMR 全部具备 | 同上：需自写；**写操作没有内置审批**，必须自己在方案里加确认环节（工具描述不能代替策略，见 `$A/dsh-tools/README.zh.md:90-96`） |
| **角色卡聊天** | bundle 声明 `preset-<id>` + `dsh-persona.config.prefix` 写全文；设置页选中/设为默认 | 完全具备，零新依赖（§4） | 无。可选：`complete: true` 只在"纯 RP、不要工具引导"时用 |
| **主动发起对话** | ① 复用 `dsh-schedule`（工具/UI/服务三种入口，持久化）；② 插件内"轮询到新事件 → `agent.followup()`"即时搭话 | `schedule` 服务 + 4 个工具 + 自动化任务 UI 全部已挂（§5） | **进程生命周期**：Desktop 不运行就不投递；没有"推送预置助手文本"的 API（只能唤醒模型让它说） |

### 最大风险 / 缺口（按严重度）

1. **主动对话依赖宿主常驻。** schedule 的 timer 活在 Host 进程里，DSH Desktop 关闭期间不投递，重启后只补最近一次（`$A/dsh-schedule/README.zh.md:279,285`）。若用户期待"微信式随时收到主动消息"，方案必须外置（系统计划任务 / 常驻小服务），否则承诺不了。
2. **凭据不是安全边界。** agent 的 shell 与插件同用户，都能读 `.credentials.yaml`（`README.zh.md:115`）。把第三方 token 交给 MCP server 子进程（环境变量注入）比放进 profile 配置更干净，但仍不是隔离。
3. **写操作无内置审批。** 发帖类工具必须自己做确认门（`tools/pre-execute` / `ctx.tools.guard()`），否则模型一次误判就直接对外发布。
4. **版本漂移。** 本机是 Desktop 0.2.2-rc.1（asar 内），而 `profiles/node_modules` 里躺着 0.1.5-rc.3 的 junction。任何"照着旧源码写"的插件都会在激活时炸；以 `$A` 为准，并注意 `plugin_manager` 对 DSH 版本有引擎校验。
5. **交付形态约束。** 必须走 `plugin_manager install_bundle`（要 Full access 或批准）；替换已装包需要重启才能生效（`host-plugin.md:83`）。手改 profile 文件会被 skill 明确禁止。

---

## 附 A：复核办法（给 Lead/实现者）

1. 直接读 asar 内文件：`read` 工具可用于 `<DSH_INSTALL>\resources\app.asar\dsh\...`；`grep`/`glob`/shell 打不开 asar。
2. 需要批量 grep 时：Node 解析 asar 头（前 16 字节 → `pickleSize=readUInt32LE(4)`、`jsonLen=headerBuf.readUInt32LE(4)`，JSON 从 offset 16+8 开始，数据基址 `8+pickleSize`，每个文件 `offset` 相对该基址），把目标包抽到工作区再 grep。本次即用此法，抽取的源码与 asar 内文件逐字节一致，故行号可直接引用。
3. 运行时真源（不用读源码）：`cordis_inspect_list` → `cordis_inspect_query`（`Config.listConfigs` 查插件 Config schema、`Tool` 查当前 agent 可见工具、`Service` 查服务方法）。
4. 配置真源：`plugin_manager list_bundles` / `list_plugins`（`enabled` + `fiberPhase`），或 `dsh --profile desktop --dump-config`。
