# 小肥鱼 · B站连接器（DeepSeek Harness 插件）

把 DeepSeek Harness（DSH）变成一个会刷 B 站、会用「大肥鱼」人设聊天的 agent：
**只读 B 站热点/视频/评论 + 角色卡人格 + 到点主动开口**。

> 当前阶段：P0（只读）。评论/发帖的写通道、X（推特）接入在计划中，见文末路线图。

## 仓库里有什么

```
feiyu-connector/     ← 可安装的 DSH Host bundle（插件本体）
  index.js           5 个 B 站只读工具 + 1 个心跳运维工具 feiyu_heartbeat
  lib/bili.js        B 站 HTTP 客户端：wbi 签名（失败降级）、10s 超时、重试 1 次、5 分钟 TTL 缓存
  lib/companion.js   心跳/自主行动：首次对话后自动计时，到点真的去 B 站搜内容再开口
  cordis.patch.yml   插件行 + preset-feiyu（persona.prefix = 角色卡全文 + 自主行动规则，complete: true）
  locale/ icon.svg README.md
persona/dafeiyu.md   角色卡（来源 aureth-labs/dsh-aurabot-qq，MIT，正文未改写）
tools/               零依赖验证：check-bundle.mjs（静态 48 项）、test-bili-client.mjs（真实网络 12 项）
docs/
  解决方案-大肥鱼接入B站与X.md   方案讨论稿（架构/路线对比/分期）
  spec-feiyu-connector.md        实现规格（工具契约与验收）
  dsh-integration-notes.md       DSH 集成点调研（插件/预设/定时/凭据的源码级结论）
  bundle-verification.md         验证报告（含定时链路投递证据）
  使用指南-小肥鱼.md             三步上手
```

## 快速开始

前置：DSH Desktop（`0.2.x`）、Node ≥ 22。

1. 安装插件（工作区里执行）：把 `feiyu-connector/` 的**绝对路径**交给 DSH 的插件管理器安装（`install_bundle`），安装后启用一次。
2. 新建会话 → 预设选 **小肥鱼**。
3. 聊天：说「今天 B 站有什么热闹的」→ 会调用 `bili_hot` 并用角色口吻回答。
4. 主动行动：**不需要设置**。该会话第一次说话后插件自动开始心跳（20 分钟首跳、约每 90 分钟一次、23:00–08:00 静默、每日 ≤6 次）。到点它真的去搜/看 B 站内容再主动开口，而不是打招呼。用 `feiyu_heartbeat({action:"status"})` 查看状态，`fire` 可立即触发一次。

## 验证

```bash
node tools/check-bundle.mjs        # 静态检查：期望 PASS 46 / FAIL 0 / SKIP 2
node tools/test-bili-client.mjs    # 真实网络：期望 PASS 12 / FAIL 0
```

## 设计与边界

- **零 npm 依赖**：只用 `node:crypto` 与全局 `fetch`，无构建步骤。
- **只读、无凭据**：P0 不登录、不读任何密钥；B 站公开接口即可覆盖热搜/排行/搜索/详情/评论。
- **主动开口依赖 DSH 运行**：DSH 关掉不会发；重新打开只补最近一次。
- **写操作**（评论/发帖）默认不做，P1 会做成「草稿 → 用户确认 → 发布」+ 一次性 token + 每日上限 + 审计日志。
- **X**：需要账号与代理，一期不接。

## 路线图

- [x] P0 只读工具 + 角色卡预设 + 定时主动（已落地并验证）
- [ ] P1 评论草稿/发布（确认门 + 审计）
- [ ] P1.5 companion：插件后台维护人设会话并自动唤醒，主动开口无需手工建任务
- [ ] P2 X 读取（官方 API 或 Grok OAuth）

## 第三方与许可

- 角色卡正文来自 [`aureth-labs/dsh-aurabot-qq`](https://github.com/aureth-labs/dsh-aurabot-qq) 的 `personas/dafeiyu.md`（MIT License），未改写，出处已在文件头注明。
- 本仓库代码为本地自研，未附带 LICENSE 文件；如需开源请先确认角色卡的再分发条款。
