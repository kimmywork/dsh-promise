# 接入点与触发点（对照 Promise Agent 系列）

这份文档回答三个问题：

1. 文章里的概念，在这套实现里对应什么；
2. `subagent` / Agent Teams / ds-bot 分别能「无感」到什么程度，哪些情况必须多一次调用；
3. 所有 hook、事件、工具、UI 反馈分别发生在哪一步、哪个文件。

---

## 1. 文章概念 → 实现映射

| 文章概念 | 本文实现 | 说明 |
|---|---|---|
| 自治（autonomy） | `PromiseRecord.agent` 只是一个标签，插件不控制 agent 内部 | 插件只做匹配、记账、评估，不接管执行 |
| 正向承诺 `+b` | `promise_declare` 写入 `PromiseRecord` | statement / requirements / qos / assessment 都是可证伪字段 |
| 负向承诺 `-b`（接受） | `promise_select` 显式接受，或 `spawn_teammate/send_message/subagent` 的**隐式接受** | 接受后开 job；`promise/accepted` 记录 explicit/implicit |
| 三值评估 | `verdict.decide()` → `fulfilled / violated / undetermined` | `undetermined` 不更新信任，只记证据缺口 |
| 评估是分布的 | 规则（`system:checks`）、Jev（`judge:jev`）、用户反馈（`user:feedback`）分开记账 | 按 `(agent × capability × assessor)` 存 |
| 信任 | `trust.js`：证据加权 + 时间衰减 + Wilson 下界 | 文章未给公式；这里用可重放的工程近似 |
| 超级代理 | `promise_compose` + `composition` 记录 | 外部信任与子代理健康分离 |
| L0–L3 评估阶梯 | `planner.planLevel()` | 风险/可逆/价值/证据量/预算共同决定，模型不自报 |
| 三层评估 | `assess.js`：absolute / relative / process | relative 用账本基线，不用反事实 |
| 迁移四阶段 | README 的 P0–P3 / `examples/` | 声明、L1、L2 抽样、L3 门禁 |
| 「结果带可信度」 | `promise_select` / `promise_settle` 卡片 + `promise_inspect` | 自动路径另见 §5 |
| 工具也是承诺 | `agent` 可用 `tool:<name>`，`invokeHint` 返回 `{kind:"tool"}` | 工具承诺仍需手动 settle |
| 无中央控制 | 不成立也不假装成立：DSH 仍有 Lead/编排器 | 本实现把委派变成**有记录、可质询**，而不是取消编排 |

---

## 2. 触发点全景（host 侧）

| # | 触发 | 条件 | 动作 | 位置 |
|---|---|---|---|---|
| 1 | `promise_declare` 工具 | 任意 | 写 `promise/declared` 或 `promise/updated` | `tools.js` → `engine.declare` |
| 2 | `promise_select` 工具 | 多候选 / 多承诺时 | 排序、开 job（`attribution: "explicit"`） | `engine.select` |
| 3 | **`tools/post-execute`** | 工具名 ∈ `spawn_teammate`、`send_message`、`subagent`、`subagent_fork`，且结果成功 | 解析子会话 id；找到一个匹配的 open job；没有则**隐式 select**（该 agent 恰好 1 条 active 承诺）；写 `job/linked`；返回卡片注释 | `index.js` → `engine.bindToolDelegation` → `#openImplicitJob` |
| 4 | **`subagent/end`** | 有 job 绑到该 child session | 读子会话输出，结算 | `index.js` → `engine.settleDelegated` |
| 5 | **teammate 轮询** | job 绑定到 team 成员 | 每 1.5s 查 `agentTeams.listMembers`，成员变 `inactive/failed` 时结算 | `engine.#watchDelegation` |
| 6 | 子会话 `turn/end` | job 绑到该 session | 结算（subagent/team 的兜底） | `index.js` → `engine.onSessionTurnEnd` |
| 7 | Lead `turn/end` | 有显式 select 的 open job，**且未委派** | 自动 L1 结算 | `engine.autoSettle`（delegated job 被跳过） |
| 8 | `feedback/message-put` | 有对应 turn 的 job | 追加 `user:feedback` 评估 | `engine.attachFeedback` |
| 9 | `promise_settle` 工具 | 手动兜底 / 自干 | 检查、评估、信任、违约 | `engine.settle` |
| 10 | `promise_delegate` 工具 | 需要插件替你派活或注入契约 | spawn/send/subagent + `job/linked` | `tools.js` |
| 11 | `promise_compose` 工具 | 需要超级代理 | 外部承诺 + composition | `engine.compose` |
| 12 | 客户端 `plugins.row.config` | 打开插件页的 `promise` 行 | Jev Base URL / Model / API Key 表单 | `lib/client.js` |

账本事件：`promise/declared|updated`、`job/opened`、`job/linked`、`assessment/recorded`、`promise/accepted|declined`、`breach`、`job/closed`、`composition/declared`、`observation/unattributed`。

---

## 3. 无感程度：subagent / Agent Teams / ds-bot

### Agent Teams

```text
spawn_teammate(name, prompt) ──post-execute──▶ job（隐式 select）
                                             └─▶ job/linked（roster 反查 session id）
                                                 └─▶ 轮询到 inactive ──▶ settle
```

| 场景 | 是否需要额外调用 | 说明 |
|---|---|---|
| agent 恰好 1 条 active 承诺 | **不需要** | `spawn_teammate` / `send_message` 一条调用完成 |
| agent 有多条 active 承诺 | 需要 `promise_select` | hook 不知道这次是哪个 capability |
| 要显式 `PROMISE ACCEPTED` 契约 | 需要 `promise_delegate` | `pre-execute` 不能改写参数，`post-execute` 时 prompt 已发出 |
| 同一 session 有多个同 agent 的 open job | 不绑定 | 避免张冠李戴；用 `promise_delegate` 指定 jobId |

### subagent

| 场景 | 是否需要额外调用 | 说明 |
|---|---|---|
| 调用带 `agent_preset`，且该 preset 恰好 1 条承诺 | **不需要** | `subagent` 结果里的 `subagentId` 就是 child session id；`subagent/end` 触发结算 |
| 未带 `agent_preset`（继承父 preset） | 无法绑定 | 插件不知道子 agent 的 preset；这是当前缺口 |
| preset 有多条承诺 | 需要 `promise_select` | 同上 |
| 本部署（Agent Teams profile） | subagent 工具被禁用 | 实际走 team 路径；代码路径仅单测覆盖 |

### ds-bot（暂缓）

当前**不在范围内**：`message_bot` 的工具结果没有 bot 的 session id，插件无法关联到 bot 会话，也不能自动结算。
代码里 `bot:` 前缀和提示仍保留（显式声明/手动 settle 可用），但不在 UI 或自动接入里承诺支持。

结论：**Agent Teams 可以无感（单承诺）；subagent 在带 preset 时可以无感；ds-bot 暂缓**。多承诺是唯一需要一次 `promise_select` 的自动路径缺口。

---

## 4. 时序（自动路径）

```text
Lead                     DSH tools               plugin                    child session
 │  promise_select(opt)     │                       │                          │
 │─────────────────────────▶│  tools/pre-execute     │                          │
 │  spawn_teammate(name)    │───────────────────────▶│ (allow)                  │
 │─────────────────────────▶│  tool body             │                          │
 │                          │───────────────────────▶│ spawn / send             │
 │                          │  tools/post-execute    │                          │
 │                          │───────────────────────▶│ bind job ↔ child         │
 │                          │◀───────────────────────│ annotate card            │
 │                          │                        │ watch roster / subagent/end
 │                          │                        │◀── turn/end or inactive ─│
 │                          │                        │ settle (L1/L2/L3, Jev)   │
 │                          │                        │ trust / breach           │
```

---

## 5. UI 反馈

| 场景 | 反馈 | 位置 |
|---|---|---|
| 显式 select | 候选排序卡片（agent、trust、lower、reasons） | `promise_select` 的 `presentCall/presentResult` |
| 显式 settle | 结算卡片（verdict、三层分、信任增量、breach） | `promise_settle` |
| 自动绑定（spawn/send/subagent） | 工具卡追加一行：`↳ promise code.review.plugin · job … · L2 — bound automatically; settlement will be recorded` | `index.js` post-execute；`ui.annotateDelegation` 可关 |
| 自动结算 | **没有即时卡片**（发生在后台，不产生工具调用）；用 `promise_inspect` 查 | 缺口，见下 |
| Jev 连接 | 插件页 `promise` 行的配置表单 | `lib/client.js` |
| 信任总览 | `promise_inspect({what:"trust"})` 文本表 | `engine.inspect` |

### 在「子智能体 / 智能体团队」面板上标注 promise 与 credit

先说限制：这两个面板的成员行都是各自插件的内部组件，**没有暴露行级 slot**：

- `dsh-client-ui-subagent` 只暴露 `conversation.session.header.actions` / `header.lineage` / `sidebar.*`，行内容来自 `subagentCatalog` 投影；
- `dsh-client-ui-agent-team` 只暴露 `conversation.session.header.actions`，成员卡是内部渲染。

所以「直接在那两行上加 badge」需要上游新增 slot，例如：

```text
agentTeam.member.badge     (member) -> ReactNode
subagent.row.meta          (session) -> ReactNode
```

在不动上游的前提下，可行的自建面是**一个同级 header action + 面板**，同时覆盖两类：

```text
┌ 页头：…  [3 个子智能体]  [智能体团队]  [Promise 3 · 0.58] ┐
│                                                          │
│  Team members                                             │
│   ● code-reviewer   code.review.plugin   0.58 ▁▂▃  2 次   │
│   ○ history-rewriter repo.history-rewrite 0.50  —   0 次  │
│                                                          │
│  Subagents                                                │
│   ● run 21s         code.change           0.62 ▁▃▅  1 次   │
│                                                          │
│  最近结算  fulfilled  L3  0.86  [账本 #41]                │
└──────────────────────────────────────────────────────────┘
```

每行建议显示：`name/title`、`capability`、`credit = trust（lower · 证据数）`、最近 verdict 状态点（绿/黄/红/灰）、`probation/suspended` 标签；展开后显示 promise statement、QoS、最近 3 条评估（verdict、三层分、model、confidence）与账本序号。

数据映射：team 成员 / subagent 的 **child sessionId** → 账本里 `job.delegation.sessionId` → job → promise → 该 `(agent, capability)` 的 trust。这样两类面板可以用同一份快照。

实现路径（建议）：
1. host 侧加一个只读 Remote `promiseInventory.snapshot(sessionId)`（`TypertRemoteService` + `@Remote`），返回上面这份快照；
2. client 侧在 `conversation.session.header.actions` 注册一个按钮 + 面板（React，复用现有 header action 样式）；
3. 行级 badge 作为上游 slot 提案，等 `ui-subagent` / `ui-agent-team` 接受后再接。

**已实现（A）**：会话头部新增 `承诺 N · credit` 按钮，点开是本会话的 team/subagent 行列（capability、trust/lower/证据数、最近 verdict）与最近 5 条结算。数据来自 host 的只读 Remote `promiseInventory.snapshot(sessionId)`（`src/index.js` 运行时标记 + `src/inventory.js` 快照）。

这个包不在 DSH monorepo 内，没有 Typert 生成器产物，因此 client 侧在 `lib/client.js` 里手写了单条 Remote descriptor，并通过 `ctx.remote.$mount()` 挂载；host 侧的 `TypertRemoteService` + `Remote('snapshot')` 标记由 Gateway 的 SRC fallback 发现。两条链路都是**尽力而为**：

- Client：`$mount` 失败（namespace 未发布/降级组合）时**不注册按钮**，插件页与工具不受影响；
- Host：`@deepseek-ai/dsh-typert-protocol` 导入失败或服务注册失败时只记一条 warn，插件其余部分照常启动。

0.1.1 修复了 client 工厂的 `inject is not defined`（它会让整个 Web boot 失败），并补了直接执行客户端工厂的回归测试。

---

## 6. 与文章的对应关系

- **超出文章的部分**：自动绑定、隐式 select、接受/拒绝记录、可执行 checks。文章假设代理会显式声明和接受；这里把「接受任务即许诺」工程化。
- **保持文章的部分**：承诺必须可证伪、评估分层、违约有累积后果、超级代理封装承诺。
- **明确不做**：不取消编排器、不假装信任分是真理、不让语义评估单独决定高风险 verdict、不自动推送 bot 的会话。

---

## 7. 验证状态

| 能力 | 状态 |
|---|---|
| 显式 declare/select/settle/inspect/compose | 真实宿主验证通过 |
| Jev 语义评估（代理可用时） | 真实宿主验证通过（`jev-1.14.0`） |
| 显式委派（手动 settle） | 真实宿主验证通过 |
| 隐式 select + 自动绑定 + 自动结算（team） | 单测覆盖；**需重启到含 `25d0ed3` 的 build 后做一次真实验证** |
| subagent/end 自动结算 | 单测覆盖；本部署 subagent 被禁用，未实测 |
| ds-bot 自动结算 | 不支持 |
| UI 卡片注释 | 单测覆盖；重启后可见 |

验证清单（重启后）：

```text
1. 给一个只有一条承诺的 team agent 发消息/ spawn（不 select）
2. 账本出现 job/opened(attribution=implicit) → job/linked → promise/accepted → assessment/recorded → job/closed(closedBy=delegated)
3. promise_inspect({what:"trust"}) 出现该 agent 的新证据
4. 委派工具卡出现 ↳ promise 行
```

---

## 8. 代码索引

| 文件 | 角色 |
|---|---|
| `src/index.js` | 插件入口、五个/六个工具注册、`session/event`、`tools/post-execute`、`subagent/end` |
| `src/engine.js` | declare/select/settle/违约/委派绑定/隐式 select/结算 |
| `src/tools.js` | `promise_declare/select/settle/delegate/inspect/compose` |
| `src/ledger.js` | JSONL 哈希链、`job/linked`、accepted/declined 计数 |
| `src/assess.js` | Jev state/questions/映射/重采样 |
| `src/verdict.js` | 三值裁决、阈值、置信度地板 |
| `src/planner.js` | L0–L3 |
| `src/router.js` | 信任排序、`invokeHint`（preset/team/bot/tool/compose） |
| `src/collector.js` | 子会话工具轨迹/输出/反馈 |
| `src/trust.js` | 证据聚合、衰减、Wilson |
| `lib/client.js` | 插件页的 Jev 配置表单 |
