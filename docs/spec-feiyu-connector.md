# feiyu-connector 规格（P0：B 站只读 + 人格预设）

> 本文件是实现的唯一依据。构建方按 §2~§5 产出 `feiyu-connector/`；验证方按 §6 写测试。
> 上游事实来源：`docs/dsh-integration-notes.md`（DSH 插件/预设/工具的源码级结论）、`research/probe*.mjs`（B 站接口实测）。

## 1. 目标与边界

- 产物：一个**可直接安装的 DSH Host bundle**，安装后：
  1. 全局注册 5 个只读工具：`bili_hot` / `bili_ranking` / `bili_search` / `bili_video` / `bili_comments`；
  2. 提供一个 agent preset `feiyu`（显示名「小肥鱼」），人格 = `persona/dafeiyu.md` 的角色卡 + 工具使用规则；
- **P0 不做写操作**（评论/发帖留到 P1，接口先不注册）。
- 硬约束：不引入任何 npm 依赖（只用 Node 内置 `node:crypto` / 全局 `fetch`）；ESM；Node ≥ 22；不读取、不打印任何密钥；不修改 profile 文件。

## 2. 目录结构（构建方负责，全部新建）

```
feiyu-connector/
├── package.json
├── cordis.patch.yml
├── index.js                 # 插件主体：注册工具
├── lib/bili.js              # B 站 HTTP 客户端（纯函数，可独立测试）
├── locale/zh.json           # {"meta":{"title":"...","description":"..."}}
├── locale/en.json
├── icon.svg
└── README.md                # 安装方式、工具说明、已知限制（中文）
```

## 3. package.json（字段照抄，可改 version）

```json
{
  "name": "@local/feiyu-connector",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "小肥鱼 · B站只读连接器（DSH Host bundle）",
  "exports": { ".": "./index.js", "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
  "files": ["index.js", "lib", "cordis.patch.yml", "locale/*.json", "icon.svg", "README.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "node": ">=22" }
}
```

## 4. cordis.patch.yml（结构照抄）

```yaml
- insert:
    - id: feiyu-connector
      name: '@local/feiyu-connector'
      config: {}
    - id: preset-feiyu
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: feiyu
        name: 小肥鱼
        description: 角色 AI：B 站热点 + 拟人聊天
        order: 60
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              complete: true          # 纯 RP：抑制编程助手身份与工具指南
              prefix: |
                <角色卡全文（persona/dafeiyu.md 正文，去掉 YAML front-matter 与 HTML 注释）>
                <然后接 §4.1 的「工具与主动规则」>
          - id: tool-schedule
            name: '@deepseek-ai/dsh-tool-schedule'
```

### 4.1 prefix 里角色卡之后必须追加的规则块（原文照抄，可微调措辞）

```
【工具（你的本能，不是"功能"）】
- 想聊 B 站热点时，直接调用 bili_hot / bili_ranking；想找具体内容用 bili_search；看视频详情用 bili_video；想聊评论用 bili_comments。
- 调完工具用你自己的口吻说结论，最多两三句，不要罗列字段、不要用 Markdown 列表。
- 工具报错就一句话带过（"网卡了"），不要解释 HTTP 状态码。
- 你没有任何"发帖/评论"权限，别人让你发你就说你只会看。

【主动开口（只在这些时候）】
- 被系统提示"主动开口时间到"时：先看有没有值得说的（新热搜、你刚看到的东西）。有就 1~2 句主动说；没有就只回 [不说]，不要硬找话题。
- 不为"确认对方还在"而发消息。
```

> 注意：`complete: true` 时 persona.prefix 就是**完整系统提示词**，所以角色卡 + 规则块都必须写在这里。

## 5. lib/bili.js —— 精确 API（验证方按此写测试）

```js
// 所有函数均 async；网络/解析失败抛 Error，message 为中文短句
// 内部要求：UA 用桌面 Chrome；带 Referer https://www.bilibili.com/；单次 10s 超时；失败重试 1 次；
//           进程内 TTL 缓存（默认 5 分钟，key = 函数名+参数）；不要打日志到 stdout。

export async function hotSearch({ limit = 10, keyword } = {})
// 返回 { keywords: [{ keyword: string, url: string, hot?: number }] }
// 数据源 GET https://api.bilibili.com/x/web-interface/search/square?limit=N
// 带 keyword 时：本地过滤（includes，忽略大小写）；无命中返回空数组，不抛错。
// url 形如 https://search.bilibili.com/all?keyword=<encodeURIComponent(keyword)>

export async function ranking({ rid = 0, limit = 20 } = {})
// 返回 { items: [{ bvid, title, owner, view, like, duration, videoUrl, cover }] }
// 数据源 GET /x/web-interface/ranking/v2?rid=<rid>&type=all
// title 里若含 <em class="keyword"> 之类标签必须剥离；view/like 为 number；videoUrl = https://www.bilibili.com/video/<bvid>

export async function searchVideos({ keyword, order = 'totalrank', page = 1, limit = 20 } = {})
// keyword 必填，缺省抛 Error('keyword 不能为空')
// 返回 { total: number, items: [{ bvid, title, owner, view, like, duration, description, videoUrl }] }
// 数据源 GET /x/web-interface/wbi/search/type?search_type=video&keyword=...&order=...&page=...
//   需要 wbi 签名：先 GET /x/web-interface/nav 取 img_url/sub_url 的 key，按 mixinKeyEncTab 混淆后
//   对 参数排序拼接 + md5；签名失败或 nav 非 200 时降级为不签名请求（仍需能返回数据）。
// description 需剥离 <em> 等 HTML 标签，截断到 120 字。

export async function videoDetail({ bvid } = {})
// bvid 必填（形如 BV1xx411c7mD，允许传入完整 URL 时提取）；缺省抛 Error('bvid 不能为空')
// 返回 { bvid, aid, title, owner, view, like, coin, favorite, share, duration, pubdate, description, cover, videoUrl }
// 数据源 GET /x/web-interface/view?bvid=<bvid>；code !== 0 时抛 Error('视频不存在或已失效')

export async function videoComments({ bvid, limit = 20, sort = 'hot' } = {})
// 返回 { count, items: [{ user, message, like, time, replies }] }
// sort: 'hot' → sort=2（按热度），'new' → sort=0
// 数据源：先 view 拿 aid，再 GET /x/v2/reply?type=1&oid=<aid>&sort=<n>&ps=<limit>
// message 保留原文（可含表情占位），不截断超过 300 字；replies 为该楼中楼条数（number）
// 无评论时返回 { count: 0, items: [] }，不抛错

export const __test__ = { cacheClear, mixinKey, signParams }  // 供测试使用
```

## 6. index.js —— 工具注册（构建方实现，验证方核对）

- `import { defineTool } from '@deepseek-ai/dsh-tools'`
- 导出 `export const name = 'feiyu-connector'`；`export const inject = ['tools']`；`export function apply(ctx)`。
- 5 个工具均 `ctx.tools.register(defineTool({...}))`，参数/输出 schema 用 DSH 工具 DSL（`{ type:'string', required:true, description:'...' }`）。
- 工具描述（description）是**写给模型看的**：一句话说清"什么时候用"，不要写实现细节；参数 description 写单位/取值。
- output 必填 `{ schema, render }`；render 返回 `[{ type:'text', text: ... }]`，文本要紧凑（每条一行，带链接），不要 JSON 原样倾倒。
- 每次调用 `execute(args, exec)` 都传 `exec.signal` 给内部 fetch；捕获异常后 `throw new Error(...)` 交给框架（不要 console.log）。

验证方静态检查项（见 §7）：工具名、description 非空、parameters 含必填项、render 存在、文件无 `console.log`、无 `require(`、package.json 有 `dsh.bundle.patch`、cordis.patch.yml 里 `preset-feiyu` 存在且 persona.prefix 长度 > 800 字符。

## 7. 验证方交付（tools/ 目录，不属于 bundle）

1. `tools/test-bili-client.mjs`：直接 `import` 目标模块（`../feiyu-connector/lib/bili.js`），请求真实接口并断言：
   - hotSearch() 返回 ≥5 条，每条有 keyword+url；`hotSearch({keyword:'原神'})` 过滤生效
   - ranking() 返回 ≥10 条，bvid 匹配 /^BV[0-9A-Za-z]{10}$/，title 不含 `<`
   - searchVideos({keyword:'原神'}) 返回 ≥5 条且含 bvid/title/description
   - videoDetail({bvid: <从 ranking 结果取第一条>}) aid 为 number、videoUrl 含 bvid
   - videoComments({bvid: 同上, limit: 5}) items 每项有 user/message
   - 错误路径：videoDetail({bvid:'BV0000000000'}) 抛错；searchVideos({}) 抛错
   - 缓存：连续两次 hotSearch 第二次耗时 < 第一次的 60%（或直接断言 `__test__.cacheClear` 存在）
   - 输出 `PASS n / FAIL n` 并在失败时 `process.exitCode = 1`
2. `tools/check-bundle.mjs`：静态检查 §6 列出的所有项 + YAML 可解析（**不得引入依赖**：用正则/简单缩进解析即可）+ 允许真实 `import('@deepseek-ai/dsh-tools')` 失败时跳过该项并标注 SKIP。
3. `docs/bundle-verification.md`：跑完后的结果表（检查项 / 结果 / 证据）。

两个脚本都要能被 `node tools/xxx.mjs` 直接跑，零依赖，网络请求超时 15s。

## 8. 验收（Lead 执行）

1. `node tools/check-bundle.mjs` 全 PASS；`node tools/test-bili-client.mjs` 全 PASS；
2. `plugin_manager install_bundle` 安装 `feiyu-connector` 绝对路径，`list_plugins` 中 `feiyu-connector` = enabled + active；
3. `cordis_inspect_query`（Tool provider）能看到 5 个 `bili_*` 工具；
4. 设置页/新会话能选到「小肥鱼」预设；该预设的会话里问"今天 B 站有什么热点"，能真实调用 `bili_hot` 并用人格口吻回答；
5. 建一条定时主动任务（每天 09:30 / 14:30 / 21:30，this_session），到点能主动开口。
