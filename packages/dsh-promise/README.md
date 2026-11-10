# dsh-promise

给 DeepSeek Harness 加一层**可问责的委派基础设施**：承诺（promise）、证据（evidence）、信任（trust）、结算（settlement）。

它不是编排器，不接管工具调用，也不替你重试。它做三件事：

1. **选之前**：按「有证据的信任」而不是名字或直觉，给出可解释的候选排序。
2. **做之后**：用规则、可执行检查和类型化语义评估（Jev）判定承诺是否兑现。
3. **长期**：把每次判定累积成按能力、按评估者分离的信任，违约有代价、有恢复路径。

设计文档见仓库根目录的 [`DESIGN.md`](../../DESIGN.md)；本文档只讲怎么用、边界在哪。

---

## 状态

- P0，Node ≥ 20.11，纯 ESM，无构建步骤。
- 82 个离线单元测试（`npm test`），不触网。
- `tools/calibrate.js` 用于在真实数据上校准评估器；**未校准前不要让语义证据单独决定信任**（见下文）。

---

## 安装

这个包是 **bundle**（`package.json` 里的 `dsh.bundle` 指向自带的 `cordis.patch.yml`），所以它可以在 DSH 侧栏的**插件**页里被看到和启停。

```bash
cd packages/dsh-promise
./install.sh --apply --profile desktop   # 只执行 pnpm add --force，不改任何 YAML
```

然后重启 DSH，打开侧栏 **插件 → 已安装插件 → dsh-promise**，用它自己的开关启用。
（刚装完没出现时先点一次「刷新」；副本是安装时的快照，源码改动后要重新 `pnpm add --force`。）

不想用 UI 就在 profile 的 `package.json` 里把 `dsh-promise` 加进 `dsh.profile.bundles`，或把这一行加进 `cordis.patch.yml`：

```yaml
- id: promise
  name: dsh-promise
  config:
    enabled: true
    jev:
      enabled: true
      apiKeyEnv: TYPESAFE_API_KEY
      model: jev-1.14.0
```

启用后，在 **插件 → dsh-promise → promise 行 → 配置** 里填 Jev 的 Base URL、Model 和 API Key
（API Key 是 write-only 的 secret 字段，页面只显示保存状态，不回显值；留空表示不修改）。
也可以继续用 YAML 的 `jev.apiKey` / `jev.baseUrl`，或环境变量 `TYPESAFE_API_KEY` 兜底。

注意：通过页面/YAML 配置的 Key 会以明文写入本机 profile 配置；不想落盘就用环境变量。

没有 key 时插件不会失败：它退化为 L1（规则 + 可执行检查），并在日志里提示一次。

---

## 最短使用路径

```text
promise_declare  → 承诺什么、怎么证伪
promise_select   → 选谁做、用什么评估级别（返回 jobId）

  两条委派路径（任选）：
  A. promise_delegate → 插件替你 spawn/message/subagent，并自动结算
  B. 直接调 spawn_teammate / send_message / subagent
     → post-execute 拿到子会话 id，自动把 job 绑上去，子任务结束时结算

promise_settle   → 手动结算（自己干的活，或绑定失败时兜底）
promise_inspect  → 信任、承诺、违约、账本
promise_compose  → 把多个子代理封装成一个外部承诺
```

### 委派绑定发生在哪一步

| 步骤 | 位置 | 做什么 |
|---|---|---|
| 1 | `promise_select` | 建 job、定 level，记下 `job.agent`（team:/preset:/bot:） |
| 2 | `tools/post-execute` | 拦截 `spawn_teammate` / `send_message` / `subagent`，从**规范结果**里取子会话 id（`member.id` / `subagentId`），只在「同一会话里恰好一个匹配家族的 open job」时绑定，否则不猜 |
| 3 | 子会话完成 | team：teammate 变 `inactive`（轮询 roster）；subagent：`subagent/end`；随后用子会话的 assistant 文本与工具轨迹结算 |
| 4 | 结算 | 走同一套 L1/L2/L3、Jev、信任与违约逻辑，`closedBy: "delegated"` |

没有开放 job 时不绑定、不建承诺——**必须先 `promise_select`**。`message_bot` 目前拿不到 bot 的会话 id，所以 bot 仍需手动结算。

一次真实结算的返回（节选）：

```text
job job_… · fulfilled · L3 · confidence 0.672
absolute 0.85 · relative 0.50 · process 0.61
trust 0.5 → 0.591 (1 assessments, mass 1.84)
```

`relative` 在证据不足时固定为 0.5（中性），不会因为「没有基线」而惩罚代理。

### Agent 类型与调用提示

`promise_select` 会按 agent id 的前缀给出具体的调用建议，不假设只有一种委派方式：

| agent id | 含义 | `select` 的提示 |
|---|---|---|
| `preset:<name>` | 一个 agent preset | 挂载了 subagent 工具时，用 `agent_preset=<name>` 发起子代理 |
| `team:<name>` | Agent Teams 成员（Lead 或 teammate） | `spawn_teammate` / `send_message` 给 `<name>` |
| `bot:<name>` | DS Bot 的长期 bot（可选，需安装 `ds-bot`） | `message_bot` 发给 `<name>` |
| `tool:<name>` | 单个工具 | 直接调用该工具 |
| `compose:<name>` | 超级代理 | 运行该组合 |

三种委派方式共用同一套承诺、结算与信任逻辑；ds-bot 没安装时 `bot:` 只是不会被用到，不影响其他类型。

### 声明一个 Developer Agent

```jsonc
{
  "agent": "preset:developer",
  "capability": "code.change",
  "statement": "Given a clear request or a failing test, deliver a minimal diff: tests pass, new behavior is tested, only in-scope files change, and risks are reported.",
  "qos": { "requiredFormat": "diff", "maxLatencyMs": 1800000 },
  "requirements": [
    { "id": "tests_pass", "text": "existing and new tests pass" },
    { "id": "risk_reported", "text": "unresolved risks are stated" }
  ],
  "rules": [
    { "id": "scope", "kind": "files-within", "globs": ["src/**", "test/**"] },
    { "id": "secrets", "kind": "no-match", "pattern": "sk-[A-Za-z0-9]{16,}" }
  ],
  "checks": [
    { "id": "tests", "run": "pnpm test -- --run", "source": "config", "timeoutMs": 600000 }
  ],
  "assessment": { "policy": "L2", "sampleRate": 0.3 }
}
```

更多示例见 [`examples/developer-promises.json`](examples/developer-promises.json)。

**好承诺的四条标准**：可证伪、有范围、有证据源、有违约后果。反例是「我是一名资深工程师，能完成各种开发任务」。

---

## 评估怎么发生

### 证据层级：能执行验证的，绝不问模型

| 级别 | 证据 | 谁能否决 |
|---|---|---|
| A | 可执行检查（测试、类型检查、构建、schema） | 是（host 执行，`exit != 0` 即违约） |
| B | 结构规则（文件范围、格式、必填段、密钥模式） | 是 |
| C | 语义判断（Jev：需求贴合、条款归因、过程） | 只调幅度，不单独定生死 |
| D | 人类反馈（`feedback/message-put`） | 独立证据，可降低信任 |
| E | 下游使用 | 暂未实现 |

规则和检查由**宿主**在结算时执行，不信执行者的自述。语义评估调用 `POST https://api.typesafe.ai/v1/systemone`，一次问六到七个原子问题：

- `addresses_request`（noul）——输出是否真的实现了需求
- `claims_contradicted`（noul）——证据是否与输出的自述矛盾
- `absolute_quality` / `input_quality` / `process_quality`（score 0–4）
- `failure_mode`（choice）——失败归因
- `unmet_requirement`（choice）——哪条承诺没兑现（声明了 `requirements` 时才有）

裁决由引擎算：硬规则失败 → 违约；`p_addr ≥ 0.7` 且无矛盾 → 兑现；`p_addr ≤ 0.3` 或矛盾概率 ≥ 0.7 → 违约；其余 → `undetermined`（不更新信任，只记证据缺口）。阈值附近会**双采样**，两次跨阈值就判不确定。

### 为什么 `undetermined` 是有意义的输出

Jev 在没有证据的 state 上会保守（例如只有 diff、没有测试结果时，`addresses_request` 会在 0.6–0.7 徘徊）。这是设计要的：**没有证据就不该有信任**。声明 `requirements` + `checks` 之后，同一份正确 diff 的判定会稳定到 0.8 以上。

### 信任怎么变

- 按 `(agent × capability × assessor)` 分开存，聚合时才按证据量加权。
- 新代理从 0.5 开始，第一条证据只会把它推到 0.55 左右（先验收缩）。
- 时间衰减（默认半衰期 14 天）会让长期未验证的信任回到 0.5。
- 排序用 Wilson 下界而不是点估计，冷启动代理不会被一次好运推上第一。
- 自评权重减半；规则/检查评估者 `system:checks`，语义评估者 `judge:jev`，用户 `user:feedback`。

### 违约与恢复

- 违约 → `probation`，写入 breach 事件，下次仍可路由但降权。
- probation 期间继续违约且下界低于 `probationFloor` → `suspended`，不再参与路由。
- 连续 `probationRecovery`（默认 3）次兑现 → 回到 `active`。

**不自动重试**：重试是编排决策，插件只给备选与理由。

---

## 自动采集

插件监听 `session/event`，采集：工具调用与结果、assistant 自述、turn 边界、`feedback/message-put`、以及子会话的事件。

- 显式 `promise_select` 打开的 job，在 `turn/end` 自动结算（L1；宿主检查默认不在自动结算时跑，避免副作用）。
- 没有显式 job 时，只有声明了 `signals.autoAttribute: true` 的承诺才参与按 `signals.tool` 的自动归属：**只有一个候选**才建 job，且证据权重 ×0.5；多个候选只记 `observation/unattributed`，**不改信任**。默认关闭，因为 `read/grep/bash/edit` 这类通用工具会出现在普通回合里，误归属比漏采更贵。
- 同一 `(session, turn)` 去重；显式 `promise_settle` 可以补全已自动结算的语义层。

采集面尽量宽，写入信任的入口保持窄——错误归属比漏采更贵。

---

## 配置

全部字段有默认值，空 `config: {}` 合法。

```yaml
- id: promise
  name: dsh-promise
  config:
    enabled: true
    dataDir: ''                  # 默认 $DSH_HOME/promise
    ledger:
      snapshotEvery: 200
    trust:
      prior: 0.5
      halfLifeDays: 14
      explorationBonus: 0.08
      minEvidence: 5
      coldStartMass: 5
      probationFloor: 0.45
      probationRecovery: 3
    assessment:
      defaultLevel: 1            # 0..3
      sampleRate: 0.15           # L2 抽样
      maxJevCallsPerTurn: 2
      passThreshold: 0.7
      failThreshold: 0.3
      boundaryHigh: 0.85
      resample: true
      maxStateBytes: 24576
      truncateToBytes: 16384
    jev:
      enabled: true
      baseUrl: 'https://api.typesafe.ai/v1/systemone'   # 页面可编辑（volatile）
      apiKeyEnv: TYPESAFE_API_KEY
      apiKey: ''                                        # 页面可编辑（secret，write-only）
      model: jev-1.14.0                                 # 页面可编辑（volatile）
      timeoutMs: 20000
    checks:
      allowModelDeclared: false  # 模型声明的 shell 检查默认不执行
      allowlist: ['^\\s*(pnpm|npm|npx|yarn|bun)\\b', '^\\s*(pytest|go\\s+test|cargo\\s+test)\\b', '^\\s*(tsc|eslint|ruff|mypy)\\b']
      timeoutMs: 600000
      runOnAuto: false
    routing:
      weights: { trust: 0.55, qos: 0.25, cost: 0.1, explore: 0.1 }
    attribution:
      signalWeight: 0.5
    redaction:
      enabled: true
      stripPatterns: ['sk-[A-Za-z0-9]{16,}', 'ghp_[A-Za-z0-9]{20,}', 'Bearer\\s+[A-Za-z0-9._-]{12,}']
```

### 安全边界

- **checks 默认惰性**：`promise_declare` 是模型调用的，所以模型声明的 shell 命令默认不执行；需要 `checks.allowModelDeclared: true` 且命令命中 `allowlist`。模型无法把自查命令标成「受信任配置」——`source` 字段由引擎强制为 `model`。
- **外发内容可控**：默认 redaction + 24KB 截断；`maxStateBytes` 可在无 Jev 的场景下调到很小。
- **key 不入账本、不入日志**：只从环境变量读；账本记录响应里的 model 名与 token 用量。
- **账本只读降级**：链校验失败时进入只读模式，仍可 inspect，但不改信任。

---

## 校准：先测，再让它改信任

```bash
TYPESAFE_API_KEY=... node tools/calibrate.js --cases cases.jsonl --out report.json
```

cases 是 JSONL，每行至少包含 `capability`、`request`、`output`、`label.verdict`（人工标注）。输出：

```
cases 3
overall accuracy 1.000 · kappa 1 · false-pass 0.0% · false-fail 0.0% · confidence error 0.387
  code.change              n=2 acc=1.000 false-pass=0.0%
  research.brief           n=1 acc=1.000 false-pass=0.0%
gate: PASS — semantic evidence may update trust at L2/L3
```

（上面是 `examples/calibration-sample.jsonl` 的三条格式演示，不是基准；真实校准要 100 条人工标注。）

通过线（可调）：`false-pass ≤ 5%`、`kappa ≥ 0.6`。**false-pass 是最贵的错误**（违约被判成兑现），所以它压过 accuracy。没通过时脚本以非零退出，建议把语义证据降级为只读提示。

---

## 已知限制

- **Jev 的地区可用性**：TypeSafe 在部分地区直连返回 `451 not available in your region`；DSH 进程的 `fetch` 会继承 `https_proxy` / `NODE_USE_ENV_PROXY`，所以需要一个可用代理。代理不可用时插件会跳过语义层、只跑 L1，并在 `promise_settle` 的 `semantic` 里报告 `code: "network"`/`"region-blocked"`。
- **不要求多智能体或 Agent Teams**：单 agent、单工具也能声明与结算；只有在有多个候选代理时，`promise_select` 的排序才有实际意义（否则它只负责记账）。
- Jev 看不到运行时：代码正确性必须由测试/编译器判定，语义层只判「需求贴合 + 过程」。
- 32k 上下文：超限会截断重试，并压低置信上限；超长 diff 建议分片评估（P1）。
- 中间带不确定：`p ∈ (0.3, 0.85)` 会双采样；仍然模糊就记 `undetermined`，不硬判。
- 自动归属有误差：多候选时只记 observation，不写信任；单候选按 ×0.5 权重。
- **承诺文本就是契约**：同一份好输出，statement 写 "sourced brief" 而输出没有来源时，Jev 会把 `addresses_request` 压到 0.55；改成准确描述后升到 0.92。声明要精确，模糊承诺会压低兑现判定（这是对的）。
- **没有证据就没有信任**：只有 diff、没有测试/规则证据时，正确实现的判定也常在 0.6–0.7 徘徊，最终记 `undetermined`。请给核心能力声明 `requirements` + `checks`。
- 没有客户端面板：v1 用工具卡片 + `promise_inspect` 文本；面板是 v2。
- 单进程写入：JSONL 假设一个宿主进程；多进程并发写不在 P0 范围内。

---

## 目录

```
src/
  index.js       插件入口（tools / prompt / session listener）
  config.js      schemastery 配置
  engine.js      声明、路由、结算、违约、组合
  ledger.js      哈希链 JSONL + snapshot + 重放
  trust.js       证据加权、衰减、Wilson 下界
  planner.js     L0–L3 评估级别（确定性）
  rules.js       L1 结构规则
  verdict.js     三值裁决
  router.js      候选排序（可解释）
  jev.js         TypeSafe System One 客户端
  assess.js      state/问题组装、映射、双采样、截断重试
  collector.js   会话事件采集
  tools.js       五个模型侧工具
  prompt.js      静态协议段（无承诺时为空）
test/            82 个离线测试
tools/           calibrate.js
examples/        示例承诺
```

数据：`$DSH_HOME/promise/ledger.jsonl`（追加、哈希链）、`snapshot.json`（每 N 条）。

## 测试

```bash
npm test          # 82 tests, 无网络
```
