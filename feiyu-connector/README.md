# 小肥鱼 · B站连接器（feiyu-connector）

一个零依赖的 DSH Host bundle，装好后提供两样东西：

1. **5 个只读工具**（全局注册，所有会话可用）：`bili_hot` / `bili_ranking` / `bili_search` / `bili_video` / `bili_comments`；
2. **一个 agent preset「小肥鱼」**：角色卡全文写进 `dsh-persona.prefix`，`complete: true`（纯角色扮演，不掺编程助手身份）。

P0 只读，不含任何发帖/评论/点赞等写操作。

## 安装

在工作区用 `plugin_manager` 安装本目录的**绝对路径**（不要手改 profile 文件）：

```text
plugin_manager(action: "install_bundle", target: "D:/pr_g/ohjingjing/feiyu-connector")
```

装完 `list_plugins` 里 `feiyu-connector` 应为 `enabled` + `active`；新装 bundle 可经 HMR 激活，替换同名包需要重启 Host 才会加载新模块。

装好后：

- 设置页 → Agent preset 里可以选「小肥鱼」（也可设为新任务默认）；
- 任意会话都能看到 5 个 `bili_*` 工具（工具是 Host 全局注册的，不限于该 preset）；
- **首次对话后自动开始心跳**：该「小肥鱼」会话第一次进入 agent 轮次时，插件自动武装一个计时器（20 分钟首跳，之后约每 90 分钟一次，23:00–08:00 静默，每日最多 6 次）。到点它会真的去 `bili_hot`/`bili_ranking`/`bili_search` 找内容，再用角色口吻主动说 1~2 句，而不是打招呼。
- 运维工具 `feiyu_heartbeat`：`status` 看已武装会话与下次时间，`fire` 立即投递一次（便于验证），`arm`/`disarm` 手动管理。

## 工具

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `bili_hot` | 全站热搜，可按关键词本地过滤 | `keyword?` `limit?`（1-50，默认 10） |
| `bili_ranking` | 排行榜视频 | `rid?`（分区，0=全站）`limit?`（1-50，默认 20） |
| `bili_search` | 关键词搜视频 | `keyword`（必填）`order?` `page?` `limit?`（1-30，默认 20） |
| `bili_video` | 视频详情（UP/播放/点赞/投币/收藏/分享/简介） | `bvid`（必填，可传完整链接） |
| `bili_comments` | 视频评论 | `bvid`（必填）`limit?`（1-50，默认 20）`sort?`（hot/new） |

工具输出已压缩成每行一条 + 链接，避免把整段 JSON 倒进上下文。

## 实现要点

- `index.js`：注册工具；**不静态 import `@deepseek-ai/dsh-tools`**，改用动态导入 + 恒等兜底，避免 profile 里旧版本包导致整个插件不激活。
- `lib/bili.js`：纯函数 HTTP 客户端，只用内置 `node:crypto` 与全局 `fetch`；桌面 Chrome UA + `Referer: https://www.bilibili.com/`；单次 10 秒超时、失败重试 1 次；进程内 5 分钟 TTL 缓存（测试可用 `__test__.cacheClear()` 清空）。
- 搜索接口走 wbi 签名（`nav` 取 key → 64 位重排表混淆 → 参数排序拼接 + md5），**签名失败自动降级为不签名请求**，接口仍可用。
- 所有失败都抛中文短句 `Error`，不向 stdout 打印任何日志。

## 已知限制

- 只用 B 站公开接口，**没有登录态**：受限内容、需要 cookie 的接口不会返回；接口规则变化时可能临时失效。
- `bili_search` 不签名时的结果可能与签名请求略有差异（B 站策略），但一般仍能返回数据。
- 排行榜/搜索的分区、排序参数是 B 站内部值，未做枚举校验，传错会得到空结果或报错。
- 评论正文截断到 300 字以内；视频简介截断到 500 字，避免上下文膨胀。
- 主动开口依赖宿主常驻（`schedule` 的 timer 活在 Host 进程里），Desktop 关闭期间不会投递。
- 角色卡来源 `aureth-labs/dsh-aurabot-qq`（MIT）。

## 自检

```powershell
cd path/to/dsh-feiyu-connector/feiyu-connector
node --check index.js
node -e "import('./lib/bili.js').then((m) => process.stdout.write(Object.keys(m).join(', ')))"
```

`lib/bili.js` 的导出：`hotSearch`、`ranking`、`searchVideos`、`videoDetail`、`videoComments`、`mixinKey`、`signParams`、`__test__`。
