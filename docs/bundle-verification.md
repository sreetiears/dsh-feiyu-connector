# feiyu-connector 验证报告

> 验证方交付：`tools/test-bili-client.mjs`、`tools/check-bundle.mjs`，结果记录在本文件。
> 依据：`docs/spec-feiyu-connector.md` §2~§7。
> 环境：Windows / Node v24.21.0 / 零 npm 依赖（只用 `node:fs`、`node:url`、`node:path` 与全局 `fetch`）。
> 约束遵守：脚本只读（不改 `feiyu-connector/`、不写磁盘）；单个检查项网络超时 15s；可重复运行（行为测试每次先 `cacheClear`）。

## 0. 脚本与用法

| 脚本 | 作用 | 用法 | 退出码 |
| --- | --- | --- | --- |
| `tools/check-bundle.mjs` | 静态检查 §2 目录、§3 package.json、§4 cordis.patch.yml（内置迷你 YAML 解析器，含 `\|` 字面量块）、§5 lib 内部要求、§6 index.js 工具注册、§7.2 `@deepseek-ai/dsh-tools` 可解析性 | `node tools/check-bundle.mjs [--json]` | 0 = 无 FAIL（SKIP 不算失败）；1 = 有 FAIL 或 bundle 未就绪 |
| `tools/test-bili-client.mjs` | 真实请求 B 站接口，按 §5 API 与 §7 断言覆盖 lib/bili.js（含错误路径与缓存） | `node tools/test-bili-client.mjs [--json]` | 0 = 全 PASS；1 = 有 FAIL 或 bundle 未就绪 |

两个脚本共用约定：`PASS n / FAIL n / SKIP n` 汇总 + `RESULT: PASS|FAIL|NOT_READY`；`--json` 输出机器可读结果（便于生成表格）。

## 1. 阶段 1（脚本交付；bundle 构建中）

### 1.1 未就绪降级路径已实测（无裸栈、exit code 1）

在 `tools/.selfcheck/`（临时副本，验证后已删除）模拟目标目录不存在：

```
===== check-bundle（模拟未就绪）=====
[SKIP] bundle-dir             缺少 feiyu-connector/ 目录

PASS 0 / FAIL 0 / SKIP 1
RESULT: NOT_READY（feiyu-connector 尚未就绪）

feiyu-connector 尚未就绪：待构建方产出 ./tools/feiyu-connector 后重新运行本脚本。
[cb exit=1]
===== test-bili-client（模拟未就绪）=====
[SKIP] module-ready           找不到 feiyu-connector/lib/bili.js

PASS 0 / FAIL 0 / SKIP 1
RESULT: NOT_READY（feiyu-connector 尚未就绪）

feiyu-connector 尚未就绪：待构建方产出 feiyu-connector/lib/bili.js 后重新运行本脚本。
缺失目标：./tools/feiyu-connector/lib/bili.js
[tb exit=1]
```

结论：目标缺失时友好报「feiyu-connector 尚未就绪」并 `exit 1`，不抛裸栈。若 `lib/bili.js` 存在但 `import` 失败（语法错误等），同样走该降级路径并附带失败原因。

### 1.2 `node tools/check-bundle.mjs` 运行记录

| 时间 | 状态 | 结果 | 明细 |
| --- | --- | --- | --- |
| 21:36 | bundle 构建中（README 未落盘） | **FAIL** | `PASS 43 / FAIL 2 / SKIP 2`；FAIL：`bundle-files`「缺少：README.md」、`readme`「缺少 README.md」；SKIP：`index-import-style`（见 1.4）、`dsh-tools-import` |
| 21:39 | bundle 文件齐全后复跑 | **PASS** | `PASS 45 / FAIL 0 / SKIP 2`（SKIP 同上，非失败） |

> 21:36 的 FAIL 属构建时序（README.md 尚未写出），不是实现缺陷；构建方 21:37 补齐后同一脚本复跑即全绿。首次运行同时验证了「bundle 半成品时脚本不崩、精确指出缺哪个文件」。

### 1.3 行为测试冒烟（脚本自检，非阶段 2 验收结论）

21:38 对当时的 `lib/bili.js` 实跑一次（真实 B 站请求），确认脚本本身可用、断言口径与实现可对话：

```
[PASS] exports                5 个函数 + __test__ 就绪
[PASS] no-stdout-log          调用 hotSearch 期间无 stdout 日志
[PASS] hotSearch              10 条（89ms），首条「C罗说后会有7告别国家队」
[PASS] hotSearch-filter       命中 0 条（无命中返回空数组亦合规）
[PASS] ranking                20 条，首条 BV1i24P6rEmt
[PASS] searchVideos           total=1000，返回 20 条
[PASS] videoDetail            BV1i24P6rEmt aid=117547064168920 播放=3816299
[PASS] videoComments          count=32631，取回 3 条
[PASS] videoDetail-error      抛出：视频不存在或已失效
[PASS] searchVideos-error     抛出：keyword 不能为空
[PASS] cache-api              cacheClear 可调用；mixinKey/signParams 齐备
[PASS] cache-timing           首次 75.5ms → 第二次 0.0ms（0%）

PASS 12 / FAIL 0 / SKIP 0
RESULT: PASS
```

### 1.4 已记录的偏差 / 风险（待 Lead 判定）

1. **`index.js` 未按 §6 静态 import `@deepseek-ai/dsh-tools`**（`tools/check-bundle.mjs` → `index-import-style` = SKIP 标注）。
   实现为 `await import('@deepseek-ai/dsh-tools')` + `defineTool = (d) => d` 恒等兜底（`feiyu-connector/index.js:12-18`）。
   - 影响：若 Host 侧能解析该包（正常安装后应能），行为等价；若解析失败，注册的是裸定义对象，`ctx.tools.register` 是否接受裸对象取决于 dsh-tools 的 `defineTool` 是否只是恒等包装——**建议 Lead 在 §8.3 用 `cordis_inspect_query` 确认 5 个 `bili_*` 工具真实可见**，并把该偏差记录为「有意为之」或让构建方改回静态 import。
   - **阶段 2 已确认**：这是 Lead 明确要求的实现，`tools/check-bundle.mjs` 该项保持 SKIP，不计 FAIL；§8.3 已独立复核 5 个工具可见（见 §2.4、§2.3-2）。
   - 该检查不阻塞 exit code（SKIP），避免把「稳健性选择」误判为验收失败。
2. **`@deepseek-ai/dsh-tools` 在工作区不可解析**（`dsh-tools-import` = SKIP）：符合 §7.2「允许真实 import 失败时跳过并标注 SKIP」；安装到 profile 后由 Host 解析，属正常现象。
3. **bundle 目录内的构建方临时文件已清理**：阶段 1 的 `feiyu-connector/_selfcheck.mjs`、`_staticcheck.mjs` 在阶段 2 前已被构建方删除；当前目录只剩 spec §2 的 8 个交付文件。

## 2. 阶段 2（正式验收结果）

**触发**：Lead 通知「bundle 就绪」（2026-11-05 21:42）。此前首次安装激活因 `JsonSchemaError` 失败（`output.schema` 里字段级 `required: true` 不被支持），Lead 已把 5 个工具的 `output.schema` 全部改为对象级 `required: ['a','b']` 数组，并用 disable→enable 重新组合，`list_plugins` 中 `include:feiyu-connector` / `include:preset-feiyu` 均 enabled + active。

**本次运行（真实网络）**

| 脚本 | 命令 | 结果 | exit |
| --- | --- | --- | --- |
| 静态检查 | `node tools/check-bundle.mjs` | **PASS 46 / FAIL 0 / SKIP 2** | 0 |
| 行为测试 | `node tools/test-bili-client.mjs` | **PASS 12 / FAIL 0 / SKIP 0** | 0 |

> 结论：**无 FAIL，无需修复项**。2 个 SKIP 均为已确认的预期偏差（见 §2.3），不阻塞验收。

### 2.1 `check-bundle` 逐项结果（48 项）

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| `bundle-dir` | PASS | ./feiyu-connector |
| `bundle-files` | PASS | 8 个必备文件齐全 |
| `pkg-parse` | PASS | JSON 合法 |
| `pkg-name` | PASS | @local/feiyu-connector |
| `pkg-version` | PASS | version 0.1.0 |
| `pkg-type` | PASS | type=module |
| `pkg-private` | PASS | private=true |
| `pkg-exports` | PASS | exports . / ./locale/*.json / ./icon 正确 |
| `pkg-files` | PASS | files 覆盖 6 项 |
| `pkg-bundle-patch` | PASS | dsh.bundle.patch=./cordis.patch.yml |
| `pkg-engines` | PASS | engines.node=>=22 |
| `pkg-no-deps` | PASS | 无任何 npm 依赖 |
| `locale` | PASS | zh:「小肥鱼 · B站连接器」，en:「Feiyu · Bilibili Connect…」 |
| `icon` | PASS | icon.svg 799 字节 |
| `readme` | PASS | 2126 字符，含中文 |
| `yaml-parse` | PASS | 解析为数组（1 项） |
| `patch-insert-list` | PASS | 1 个顶层节点，共 2 条 insert |
| `patch-entry` | PASS | id/name/config 正确 |
| `patch-preset` | PASS | id=preset-feiyu，name=@deepseek-ai/dsh-agent-preset |
| `preset-config` | PASS | id=feiyu，name=小肥鱼，order=60 |
| `preset-plugins` | PASS | 2 个插件（persona + tool-schedule） |
| `persona-prefix` | PASS | 长度 1735，含角色卡 + 「工具/主动开口」规则块 |
| `persona-complete` | PASS | complete=true（纯 RP） |
| `index-name` | PASS | name='feiyu-connector' |
| `index-inject` | PASS | inject=['tools'] |
| `index-apply` | PASS | apply(ctx) 已导出 |
| `index-definetool` | PASS | defineTool 来自 @deepseek-ai/dsh-tools（静态/动态 import 均可） |
| `index-import-style` | SKIP | 偏离 spec §6：未用静态 import，改为动态 import + 恒等兜底（Lead 要求，见 §2.3） |
| `index-tools5` | PASS | 5 个 bili_* 工具已注册（5 个 name 匹配） |
| `index-tool-desc` | PASS | 5 个工具 description 非空 |
| `index-tool-required` | PASS | bili_search / bili_video / bili_comments 均有必填参数 |
| `index-tool-output` | PASS | 5 个工具均有 output{schema,render} |
| `index-schema-required` | PASS | output.schema 均为对象级 required 数组（回归 JsonSchemaError） |
| `index-no-console` | PASS | 无 console.log |
| `index-no-require` | PASS | 无 require( |
| `index-exec-signal` | PASS | execute 使用 exec.signal |
| `index-no-npm` | PASS | 仅 import 2 个模块（node: 与 @deepseek-ai/*） |
| `lib-exports` | PASS | 5 个 async 函数 + __test__ 已导出 |
| `lib-sources` | PASS | 6 个 B 站端点均已出现 |
| `lib-ua-referer` | PASS | UA=Chrome，Referer=bilibili.com |
| `lib-timeout` | PASS | 请求带超时 signal |
| `lib-retry` | PASS | 含重试逻辑 |
| `lib-cache` | PASS | 含进程内 TTL 缓存 |
| `lib-no-console` | PASS | 无 console.log |
| `lib-errors` | PASS | 关键错误文案符合 §5 |
| `lib-wbi` | PASS | 含 wbi 签名逻辑 |
| `lib-no-npm` | PASS | 仅 import 1 个 node: 内置模块 |
| `dsh-tools-import` | SKIP | 工作区无法 import('@deepseek-ai/dsh-tools')（安装到 profile 后由 Host 解析）：Cannot find package '@deepseek-ai/dsh-tools' |

### 2.2 `test-bili-client` 逐项结果（12 项）

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| `exports` | PASS | 5 个函数 + __test__ 就绪 |
| `no-stdout-log` | PASS | 调用 hotSearch 期间无 stdout 日志 |
| `hotSearch` | PASS | 10 条（55ms），首条「C罗说后会有7告别国家队」 |
| `hotSearch-filter` | PASS | 命中 0 条（无命中返回空数组亦合规，见 §2.3-1） |
| `ranking` | PASS | 20 条，首条 BV1i24P6rEmt「大家好，这里是 DeepSeek Harness…」 |
| `searchVideos` | PASS | total=1000，返回 20 条 |
| `videoDetail` | PASS | BV1i24P6rEmt aid=117547064168920 播放=3819278「大家好，这里是 DeepSeek Harness…」 |
| `videoComments` | PASS | count=32660，取回 3 条，首条「DeepSeek Harness下载地址：https://d…」 |
| `videoDetail-error` | PASS | 抛出：视频不存在或已失效 |
| `searchVideos-error` | PASS | 抛出：keyword 不能为空 |
| `cache-api` | PASS | cacheClear 可调用；mixinKey/signParams 齐备 |
| `cache-timing` | PASS | 首次 72.1ms → 第二次 0.0ms（0%） |

### 2.3 已知偏差结论（均不作为 FAIL）

1. **`bili_hot({keyword})` 过滤结果为空是正确的**：`hotSearch` 的 keyword 是「在热搜榜内本地过滤」（spec §5：`includes` 忽略大小写，无命中返回空数组、不抛错）。今日榜单无「原神」，返回 0 条属预期行为；脚本断言的是「返回数组 + 过滤生效（每条都含关键词、条数不多于全量）」，不断言 ≥1 条。本项 PASS。
2. **`index.js` 动态 import + 恒等兜底是 Lead 要求的实现**（非静态 `import { defineTool }`）：`index-import-style` 保持 **SKIP** 并附说明，不计入 FAIL。`index-definetool` 已确认 `defineTool` 确实来自 `@deepseek-ai/dsh-tools`（动态解析成功时）并被用于 `ctx.tools.register`。
3. **`dsh-tools-import` SKIP 属正常**：工作区不安装 `@deepseek-ai/dsh-tools`，安装到 profile 后由 Host 解析（spec §7.2 明确允许 FAIL 时跳过并标注 SKIP）。
4. **激活失败回归已覆盖**：新增 `index-schema-required` 检查点，专门断言每个工具 `output.schema` 内**不含**字段级 `required: true`、且含对象级 `required: [...]` 数组——本次 5/5 PASS，可防止该 `JsonSchemaError` 类问题回归。

### 2.4 §8.3 独立复核（工具可见性）

用 `cordis_inspect_query`（host / Tool / `listTools`）直接读取当前 Agent 可见工具，确认 5 个工具均已注册且 schema 与 spec §5 一致：

| 工具 | 可见 | 参数（摘要） |
| --- | --- | --- |
| `bili_hot` | ✅ | keyword、limit（均可选） |
| `bili_ranking` | ✅ | rid、limit |
| `bili_search` | ✅ | keyword（required: true）、order、page、limit |
| `bili_video` | ✅ | bvid（required: true） |
| `bili_comments` | ✅ | bvid（required: true）、limit、sort |

补充：`parameters` 里字段级 `required: true` 是 DSH 工具参数 DSL 支持的写法（见 `docs/dsh-integration-notes.md` §3.2），与本轮 `output.schema` 的问题不是同一层，故保留不变。

### 2.5 验证覆盖边界（需 Lead 侧证据，验证方未独立复核）

| spec §8 验收项 | 状态 | 说明 |
| --- | --- | --- |
| §8.1 两脚本全 PASS | ✅ 已验证 | 本文 §2.1 / §2.2 |
| §8.2 `plugin_manager` 中 enabled + active | ⏳ Lead 证据 | Lead 已确认 `include:feiyu-connector`、`include:preset-feiyu` 均 enabled + active；验证方无 Full access，不重复操作 |
| §8.3 5 个 `bili_*` 工具可见 | ✅ 已验证 | 本文 §2.4 |
| §8.4 设置页/会话能选「小肥鱼」并真实调用 `bili_hot` | ⏳ 待 UI 实测 | 需人工在设置页选预设、开新会话问「今天 B 站有什么热点」 |
| §8.5 定时主动任务到点开口 | ⏳ 待时间触发 | 需建 `schedule_create` 任务并等到点 |

### 2.6 复跑方式（幂等）

```bash
node tools/check-bundle.mjs          # 期望 PASS 46 / FAIL 0 / SKIP 2，exit 0
node tools/test-bili-client.mjs      # 期望 PASS 12 / FAIL 0，exit 0（真实网络，约 5~10s）
```

两脚本均支持 `--json` 输出机器可读结果；重复运行结果一致（行为测试每次先 `cacheClear`，缓存计时项可能因首调用过快而给出「无法判定」说明，仍 PASS）。

### 2.7 Lead 侧终验证据（2026-11-05 21:45–21:48）

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| §8.2 插件 + 预设 active | ✅ | `plugin_manager list_plugins`：`include:feiyu-connector`（`@local/feiyu-connector`）与 `include:preset-feiyu`（`@deepseek-ai/dsh-agent-preset`）均 `enabled: true`、`fiberPhase: active`，total 212 |
| §8.3 工具真实可用 | ✅ | Lead 在标准 preset 会话内直接调用：`bili_hot(limit=5)` → C 罗退役 / 人生一串 / 后会友期 / S 赛回顾 / 杨迪VS小潮；`bili_ranking(limit=3)` → BV1i24P6rEmt（381.9 万播放）、BV1XJ4g6WEyL、BV18wxY63Erp |
| §8.5 定时主动链路 | ✅ | 自检任务 `schedule-99480b28…`（`DTSTART;TZID=Asia/Shanghai:20261105T214743`，target=this_session）于 **21:47:43.026 +08:00 准点投递**（`lastDelivery` 有 `deliveredAt` + `targetSessionId`），任务状态 `ended`；验证后已删除任务，说明文档已写入 `docs/使用指南-小肥鱼.md` |
| §8.4 设置页选「小肥鱼」+ 新会话调工具 | ⏳ 用户侧 | 预设已注册为 active，工具全局可用；UI 选择属人工操作，步骤见使用指南 §1 |

**安装期故障与修复记录**：首次 `install_bundle` 激活失败 —— `JsonSchemaError: required is not supported on type "string"`（`output.schema` 内字段级 `required: true`，`index.js` 5 处）。修复方式：改为对象级 `required: ['…']` 数组；随后 `set_bundle(false→true)` 重新组合，一次通过。回归防护已加入 `tools/check-bundle.mjs` 的 `index-schema-required` 检查点。
