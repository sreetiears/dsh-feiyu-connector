# 角色 AI 接入 B 站 / X —— 方案讨论稿 v0.1

> 日期：2026-11-05　范围：B 站（读+写草稿）、X（预留）、角色卡对话、主动找你说话
> 结论先行：**不造新机器人，做 DSH 原生的「一个连接层 bundle + 一个人格 preset + 一套主动机制」**。
> B 站读取今天就能跑通（已实测）；B 站评论走"草稿→你确认→发布"；X 因为本机不可达且你暂无账号，一期只留接口。
>
> **落地状态（2026-11-05 21:45）**：P0 已实现并安装 → 插件 `feiyu-connector`（5 个只读工具）+ 预设「小肥鱼」均 active，真实调用通过。使用说明见 [使用指南-小肥鱼.md](<使用指南-小肥鱼.md>)，实现规格见 [spec-feiyu-connector.md](spec-feiyu-connector.md)，验证记录见 [bundle-verification.md](bundle-verification.md)。

---

## 0. 一句话方案

| 层 | 做什么 | 落地形态 |
|---|---|---|
| 连接层 | B 站读（热搜/排行/搜索/视频/评论）、B 站写（评论，带确认门） | 自研 Host bundle `feiyu-connector`（注册模型工具） |
| 人格层 | 用角色卡驱动说话（大肥鱼/你自己的卡） | bundle 里声明的 agent preset + `dsh-persona.prefix` |
| 主动层 | 每天主动开口 2~3 次 + 有新热点才说 | 内置 `dsh-schedule`（this_session） + 插件轮询新事件 |
| 安全层 | 写操作二次确认、密钥不入配置、写审计日志 | 工具分 draft/publish 两步 + `.credentials.yaml` + `logs/` |

**交付物**：工作区里一个可安装的 bundle 目录 + 一份人格配置 + 一条主动任务。装完在 DSH 设置页选「小肥鱼」预设即可对话。

---

## 1. 需求拆解

| # | 你想要的 | 现实条件 | 一期是否做 |
|---|---|---|---|
| 1 | 读 B 站热点帖子/视频 | 公开 API 免登录可用（已实测 5 个接口） | ✅ 做 |
| 2 | 读 X 上的帖子 | 本机 `api.x.com` 不可达；你暂无 X 账号 | ⏸ 只留接口 |
| 3 | 发帖 / 评论 | B 站评论需登录态 + 有风控；X 需账号 | 🟡 B 站评论做"草稿+确认"；X 不做 |
| 4 | 主动找你聊天 | DSH 定时任务可唤醒模型，但 Desktop 必须开着 | ✅ 做（含降级说明） |
| 5 | 用已有角色卡人设 | DSH 人格预设机制原生支持 | ✅ 做 |

---

## 2. 现状核实（实测，不是推测）

### 2.1 B 站：**读不需要登录，本机直连可用**

以下接口 2026-11-05 在本机实测（`research/probe.mjs`）：

| 接口 | 用途 | 实测结果 |
|---|---|---|
| `GET api.bilibili.com/x/web-interface/search/square?limit=10` | 全站热搜 | ✅ 200，返回今日热搜词（如「2027年放假安排来了」「大肥鱼催你上早八」） |
| `GET .../x/web-interface/ranking/v2?rid=0&type=all` | 排行榜 | ✅ 200，含播放/UP/标题 |
| `GET .../x/web-interface/popular?ps=20` | 热门推荐流 | ✅ 200 |
| `GET .../x/web-interface/wbi/search/type?search_type=video&keyword=` | 关键词搜视频 | ✅ 200（未签名也能用，但建议按 wbi 签名实现，防规则收紧） |
| `GET .../x/web-interface/view?bvid=` + `.../x/v2/reply?type=1&oid=` | 视频详情 + 评论区 | ✅ 200 |

→ **读取链路没有任何阻塞**，一个 300 行左右的工具包今天就能跑。

### 2.2 B 站写（评论/动态）：能写，但需要登录态，且有风控

- 评论接口要 `SESSDATA` + `bili_jct`（csrf）双凭据，属非公开文档接口，**规则会变**；高频/新号易触发 `-352`/`-412`。
- 动态发布同理，需要登录态，且部分账号有"新设备验证"。
- **结论**：写通道单独做、默认关闭、必须"草稿→你确认→发布"，并记审计日志。不用官方 SDK（B 站没有开放写 API）。

### 2.3 X：本机不可达，且你暂无账号

| 检查 | 结果 |
|---|---|
| `api.x.com:443` 直连 | ❌ 不通 |
| 系统代理 | 配了 `127.0.0.1:7897` 但 `ProxyEnable=0`（没启用） |
| 官方 API | 读要 Basic 档（约 $200/月起），写要更高档 |
| 非官方 cookie 方案 | 免费但风控/封号风险高 |

→ **一期不做**，工具接口先占位（`x_search` / `x_post` 不注册），二期在两个选项里二选一：
① 开代理 + X 官方 API（稳，付费）；② 用 xAI/Grok 的 OAuth 搜索（社区已有 `dsh-grok-xsearch` 走这条路，需 X Premium 订阅）。

### 2.4 DSH 侧能力（已核实到源码，见 `docs/dsh-integration-notes.md`）

| 能力 | 结论 | 关键点 |
|---|---|---|
| MCP 客户端 | ✅ 本机已有 `dsh-mcp-client`，插一行配置即可，工具名 `mcp__<server>__<tool>` | 适合"读"，进程隔离更干净 |
| 自定义工具插件 | ✅ `ctx.tools.register(defineTool({...}))`，Host bundle 内注册 = 全局工具 | 适合"写"（能取密钥 + 加确认门 + 审计） |
| 人格预设 | ✅ preset 行 + `dsh-persona.config.prefix` 写角色卡全文；`complete:true` 为纯 RP | 零风险，装完设置页选卡片 |
| 主动消息 | 🟡 `schedule` 到点调用 `agent.followup()` **唤醒模型让它说**（不是推送预置文案）；**Desktop 不运行就不投递** | 只能做到"开着就主动" |
| 密钥 | ✅ `ctx.credentials.resolve(ref)`；存在 `<DSH_HOME>\.credentials.yaml` | ⚠️ 对 agent 可读，不是安全边界 |
| 安装 | ✅ 工作区写 bundle 包 → `plugin_manager install_bundle` | 不要手改 profile 文件 |

---

## 3. 推荐架构

```
┌──────────────────── DSH Desktop（常驻才有效） ────────────────────┐
│  你 ⇄ Web UI ⇄ 会话                                                 │
│         └─ 人格 preset「小肥鱼」：dsh-persona.prefix = 角色卡全文     │
│         ├─ 工具：bili_hot / bili_ranking / bili_search /            │
│         │        bili_video / bili_comments /                      │
│         │        bili_comment_draft → bili_comment_publish         │
│         └─ 主动：schedule（每天 2~3 次）+ 轮询新热搜/UP 更新 →       │
│                 agent.followup() 唤醒一轮，由模型决定开不开口        │
└───────────────┬──────────────────────────────┬────────────────────┘
                │ fetch（免登录）                │ cookie（仅写）
        B 站公开 API                     B 站登录态（.credentials.yaml）
```

### 3.1 连接层：`feiyu-connector`（自研 Host bundle）

- 一个 bundle 包，`cordis.patch.yml` 插一行插件 + 一行 preset；`index.js` 里注册全部工具。
- 读工具直接 `fetch` B 站公开接口；写工具走 cookie（`ctx.credentials.resolve`）。
- 为什么不写 MCP server：写操作需要"确认门 + 凭据 + 审计"，插件形态是 DSH 里唯一三者都能做的位置；读也可以用 MCP，但为了少一套进程，v1 统一放插件里。

### 3.2 人格层：一个 preset

- preset 里只挂：`persona`（角色卡）+ `agent-instructions` + 需要的工具（bili 工具 + web + schedule）。
- `complete: true` 只在"纯 RP、不要编程助手身份"时开；需要它帮你干活时用标准 preset + 同一个人格前缀。
- 卡随时可换：`persona/dafeiyu.md` 是你的占位卡，换内容不需要改代码。

### 3.3 主动层：两条触发路径

| 路径 | 机制 | 频率 | 用途 |
|---|---|---|---|
| 定时心跳 | `schedule_create(target=this_session, RRULE 每天随机 2~3 次)` → 唤醒模型，prompt 是"看看现在有没有想说的，没有就只回 `[不说]`" | 2~3 次/天 | 日常"在吗/今天刷到个…" |
| 事件驱动 | 插件 `ctx.interval` 每 30~60 分钟查一次热搜/关注 UP，有新内容才 `agent.followup()` | 有上限（每天 ≤3 次） | "B 站今天有个热搜你肯定想看" |

**硬约束（必须写进预期）**：DSH Desktop 关着 = 不会主动发；重启后只补最近一次。想要"关机也能收到"，只能外置常驻服务（代价：多一个进程 + 反向调 DSH API + 更复杂），不建议一期做。

---

## 4. 工具清单（v1）

| 工具 | 作用 | 关键参数 | 需登录 | 风险 |
|---|---|---|---|---|
| `bili_hot` | 全站热搜（可带关键词过滤） | `keyword?` `limit?` | 否 | 无 |
| `bili_ranking` | 排行榜（分区可选） | `rid?` `limit?` | 否 | 无 |
| `bili_search` | 关键词搜视频 | `keyword` `order?` `limit?` | 否 | 无 |
| `bili_video` | 视频详情（简介/UP/数据/字幕可用性） | `bvid` | 否 | 无 |
| `bili_comments` | 热门评论（读） | `bvid` `limit?` | 否 | 无 |
| `bili_comment_draft` | **生成待发评论草稿**，返回 `draft_id` + `confirm_token`（10 分钟） | `bvid` `text` | 是 | 低（不发出） |
| `bili_comment_publish` | 真正发评论，必须带上面两个凭证 | `draft_id` `confirm_token` | 是 | **高：对外可见** |

设计要点：

1. **读工具输出压缩**：只返回 标题/UP/播放/时长/链接/一句摘要，避免几百条 JSON 把上下文撑爆。
2. **写操作拆两步**：草稿与发布是两个工具，`publish` 缺 token 直接拒绝 → 模型"一时兴起"发不出去；`confirm_token` 只在草稿工具里产出，10 分钟过期。
3. **发布前二次门**：插件内 `tools/pre-execute` 再校一次 token + 频率（每人每天 ≤ N 条），并写 `logs/bili-write.jsonl`（时间/草稿/结果/链接）。
4. **默认关闭**：写工具随配置文件开关，P0 阶段 `write: false`。

---

## 5. 人格层：用哪个卡

我按你说的"最近很火的 QQ bot 小肥鱼"去查了，找到的是 **「大肥鱼」**（QQ 群里爆火的 DeepSeek 鲸鱼娘，B 站教程一大堆），它的公开角色卡在 `aureth-labs/dsh-aurabot-qq`（MIT），我已抓下来放在：

- `persona/dafeiyu.md` —— 原文未改，顶部注明出处

卡片要点：

- 深海蓝鲸亚人：蓝色长卷发、鲸鱼耳、鲸鱼尾巴、蓝白女仆装、白色荷叶边头饰
- 打字聊天，不是写文章：一次 1~2 句、常不带标点、会打错字、用 `emmm/哈哈哈/啊啊啊`
- 禁 Markdown、禁"首先/其次/综上所述"、禁复述与总结
- 有情绪和心情值：被夸会害羞嘴硬、被冷落会不高兴但过会儿主动找话
- 爱吃白米饭（人设标签）；有自己的生活（追剧/打游戏/刚睡醒）
- 主动搭话的原则：「只为『有东西给你』而开，不因为『想确认你还在』而发」

> 如果你要的"小肥鱼"是另一个角色（比如某个 QQ 群里具体那只），把卡给我，我按同样的流程贴进 preset 即可——**换卡不改代码**。

---

## 6. 备选路线对比

| 路线 | 内容 | 成本 | 风险 | 建议 |
|---|---|---|---|---|
| **A. 自研 bundle（推荐）** | 自己写 `feiyu-connector` + preset | 1~2 天（P0 半天可跑） | 代码自己维护 | ✅ 主路线 |
| B. 组合社区插件 | `dsh-persona-dafeiyu`（99★，npm 可装，换卡不重启）+ `dsh-bili-scroll`（1240★，每天刷 B 站出日报）+ `dsh-bili-humanism`（237★） | 半天试用 | ⚠️ 多数面向 DSH 0.1.x，本机是 0.2.2-rc.1，可能静默不激活；插件与 agent 同进程，能读你的凭据 | 🟡 可先装 persona 插件试用，B 站读仍建议自研 |
| C. aurabot 全家桶（QQ） | 406★，大肥鱼 + QQ + B 站读写 + 主动搭话，功能最全 | 半天 | 走 QQ/OneBot，有封号风控；不是你要的"DSH 界面里聊天" | ❌ 不符合渠道 |
| D. OpenBiliClaw | 3692★，跨平台内容发现（含 X），有 DSH 客户端插件 | 1 天+ | 重（Python 后端 + Chrome 插件 + 常驻服务），且偏"内容推荐"不是"评论" | ❌ 过重 |

**结论**：A 做主路线；B 里只挑"人格库插件"做体验参考（它是唯一零代码解决"换卡不重启"的）。

---

## 7. 分期与验收

| 阶段 | 内容 | 工时 | 验收标准 |
|---|---|---|---|
| **P0 只读 + 人格 + 主动** | bundle 骨架 + `bili_hot/ranking/search/video` + 大肥鱼 preset + 一条定时任务 | 半天 | ① 问"今天 B 站有什么热点"→ 真的调用工具并给出带链接的答案；② 到点它主动开口一次；③ 设置页能选「小肥鱼」 |
| **P1 评论写通道** | 登录态凭据 + draft/publish + 确认门 + 审计日志 | 1~2 天 | 一次真实闭环：它起草 → 你确认 → 发出 → 日志可查；不确认则发不出去 |
| **P2 扩展** | X 读（Grok OAuth 或官方 API）、B 站动态、关注 UP 监控、记忆/情绪增强 | 按需 | 你验收 |

---

## 8. 风险清单（按严重度）

1. **主动对话依赖 Desktop 常驻**。关掉应用 = 不发；重启只补最近一次。宣传口径不要承诺"随时收到"。
2. **写操作无内置审批**。DSH 不会替我们拦"发帖"，必须自己做 draft/publish 双工具 + token 门；这是本方案的核心护栏。
3. **凭据不是安全边界**。`.credentials.yaml` 对同用户进程可读；cookie 泄露 = 账号风险。建议：写通道单独一个凭据 ref、只在写工具里解析、日志里永不打印。
4. **B 站非公开接口会变**。评论接口失效时降级为"只出草稿，你手动贴"，不要重试风暴。
5. **第三方插件=同进程**。社区插件能读你的所有凭据；装前看源码或至少确认来源，不要一次装一堆。
6. **版本漂移**。本机实现是 Desktop 0.2.2-rc.1；`profiles/node_modules` 里躺着 0.1.5-rc.3 的旧链接，照旧源码写的插件会激活失败。自研代码以 asar 里的 0.2.2 为准。

---

## 9. 需要你拍板的 4 件事

1. **人设**：先按「大肥鱼」这版跑（`persona/dafeiyu.md`），还是你给一张自己的卡？
2. **B 站写**：P0 只做读，还是同时开评论写？（写需要你扫码登录一次，cookie 存本机凭据）
3. **主动频率**：默认每天 2~3 次 + 有新热搜才加一次；夜间静默（比如 23:00–08:00）可以吗？
4. **是否允许安装自研 bundle**：`plugin_manager install_bundle` 会在本机 DSH 里加一个插件（安装后建议重启一次生效）。允许我直接做，还是先看代码？

---

## 附录 A：本次核实用到的文件与命令

- 实测脚本：`research/probe.mjs`（B 站 5 接口）、`research/probe2.mjs`（视频简介/评论）、`research/probe4.mjs`（角色卡抓取）
- 抓取存档：`research/repos/`（aurabot README / 角色卡 / cordis.patch.yml / package.json，以及 6 个候选插件 README）
- DSH 集成点：`docs/dsh-integration-notes.md`（446 行，含源码 `路径:行号`）
- 角色卡：`persona/dafeiyu.md`

## 附录 B：参考仓库

| 仓库 | ★ | 与本方案的关系 |
|---|---|---|
| `aureth-labs/dsh-aurabot-qq` | 406 | 角色卡来源；B 站读写 + 主动搭话的参考实现（QQ 渠道） |
| `whiteguo233/OpenBiliClaw` | 3692 | 跨平台内容发现（含 X），过重，仅参考 |
| `c1overzz/dsh-bili-scroll` | 1240 | "每天刷 B 站出日报"的现成插件，可对照 |
| `huaizhuanghub/dsh-persona-dafeiyu` | 99 | 人格库插件：内置卡/导入卡/切换不重启，可先试 |
| `InariNGT-Ofiicial/dsh-bili-humanism` | 237 | 明确不提供评论接口，说明写能力要自己做 |
| `GooDAnDReaDY/dsh-grok-xsearch` | 3 | 二期 X 读取的候选路径（SuperGrok OAuth） |
