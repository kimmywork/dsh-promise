# dsh-promise 设计方案

> 目标：把 `promise-agent.md` 里那套「承诺—评估—信任」范式，落成 DeepSeek Harness（DSH）上可运行、可审计、可关闭的插件。
> 定位：**不是又一个编排器**，而是给 DSH 已有的委派行为加一层「可问责的信任基础设施」。
> 状态：设计稿 + P0 实现，实现见 [`packages/dsh-promise`](packages/dsh-promise/README.md)。

---

## 0. 先说结论

### 0.1 文章价值评估

**值得留下的东西（这部分是真有价值的）**

| 观点 | 为什么有价值 | 在本方案中的落点 |
|---|---|---|
| 「加代理容易，信代理难」 | 准确指出了主流多代理框架缺失的那一层：代理质量状态不是一等公民 | 信任账本 + 路由时读取 |
| 三层评估（绝对 / 相对 / 过程） | 这是全系列最硬的一个工程洞见，本质是教育评估里的 value-added assessment：控制输入质量后再看增量，能显著缓解「奖励运气」 | Jev 一次调用同时产出三层分数 |
| 评估必须默认化，而不是可选插件 | 说到了痛点上：任何框架都能加评估，但默认不做就等于没有 | L1 自动、L2 抽样、L3 门禁的评估阶梯 |
| 超级代理 = 封装「承诺」而非封装「编排」 | 比「把编排逻辑包成函数」更进一步：对外暴露的是可评估的质量契约 | composition 记录 + 外部/内部信任分离 |
| 渐进迁移四阶段 | 务实，承认冷启动和成本 | 与插件的 shadow → advisory → gated 三阶段对应 |

**需要打折或丢掉的东西**

1. **理论 rigor 不足**。Promise Theory 真正有价值的是承诺代数、极性（+b/−b）、评估算子这些可形式化的东西；文章基本只用了隐喻层面。本方案不假装形式化，只保留三条可执行语义：*只有承诺方能为自己的承诺负责*、*评估是独立且分布式的*、*没有唯一权威的信任分*。
2. **信任分数学是拍脑袋的**。α=？半衰期=？多评估者怎么聚合？置信度怎么算？文章只给了 EMA + 衰减的方向，没有给出可验证的性质。本方案把它换成「可重算的加权证据聚合 + 证据质量」，并明确它是*工程近似*，不是真理。
3. **「取消中央控制」是修辞**。DSH 里主 agent 就是编排者，插件也不可能让它消失。诚实的说法是：**把不可见的中心决策，变成有记录、有依据、可被质询的决策**。这是本方案的立场。
4. **没有任何实测数据**（作者自己也承认）。所以本方案不承诺「延迟 +5%、成本 +20%」这类数字，只承诺可测量的预算上限与可关闭的开关。
5. **选择偏差没被处理**。高信任代理被反复选中 → 证据更多 → 信任更高，形成富者愈富；低证据代理永远没有机会。文章只在「展望」里提了一句涌现行为。本方案用探索项 + 强制抽样审计来对冲。

**一句话判断**：作为「设计词汇表 + 一个强洞见（相对表现）」，它值得读；作为「可实现的系统规格」，它差得远。所以正确的做法是**借它的视角，重写它的机制**，而不是照抄。

### 0.2 为什么 Jev 是这套设计的关键拼图

传统做法是 LLM-as-judge：自由文本 + 解析 + 没有校准。文章自己也承认「judge 本身靠不住」。Jev 把这件事变成了类型化提问：

- `noul` → 「这次承诺兑现了吗」得到一个 0–1 的概率，天然对应 Promise Theory 的三值评估（真 / 假 / 不确定）；
- `score` → 绝对质量、输入质量、过程质量各一个有序档位分；
- `choice` → 失败归因（输入缺陷 / 能力不足 / 流程问题 / 规格模糊 / 工具故障）；
- 每个答案自带 `probabilities` 与 `confidence` → 可以直接作为**证据权重**，而不是当真理。

这一个接口同时解决了：结构化、可校准、低成本（$0.042 / 1M input）、低延迟。它是「评估默认化」在工程上第一次变得合理。

---

## 1. 范围与非目标

**做**
- 承诺声明（capability + QoS + 评估策略 + 版本）
- 任务路由（按信任与 QoS 排序，输出可解释的候选与调用建议）
- 结算与评估（规则层 L1、Jev 语义层 L2/L3、三层打分、三值裁决）
- 信任维护（按 capability 多维、按评估者分离、EMA + 时间衰减 + 证据质量）
- 违约处理（降级、观察期、停用、备选）
- 超级代理（组合声明、外部信任与内部健康分离）
- 账本与审计（追加写、哈希链、可重放）
- DSH 原生接入：工具、系统提示词、session 事件、subagent 路由建议

**不做（v1 明确排除）**
- 不接管/拦截工具调用（DSH 没有通用工具中间件；强行 hook 会脆）
- 不实现多轮承诺协商（议价）
- 不做跨进程/跨机器信任联邦
- 不做 Web UI 面板（先出结构化报告；UI 是 v2）
- 不默认把会话内容外发给第三方（无 API key 时纯本地 L1）

---

## 2. 概念映射：Promise Theory → DSH

| Promise Theory | DSH 中的实体 | 说明 |
|---|---|---|
| Agent（自治实体） | agent preset / subagent / 单个工具 / workflow | 只要能被委派并被评估，就是一个 promise holder |
| Promise(+b / −b) | `PromiseRecord` | +b = 我提供 X；−b = 我接受 X 并承担使用后果 |
| Assessment | L1 规则 + Jev 类型化问答 | 三值：fulfilled / violated / undetermined |
| Trust | `TrustRecord`（agent × capability × assessor） | 不是全局单一分数 |
| Superagent | composition（preset 组 / workflow 阶段） | 对外一个承诺，对内可观测 |
| 可观测性 | session 事件（事实）+ ledger（判断） | 事实与判断分离 |

重要区分：**session log 是事实**（谁在什么时候调了什么、返回了什么），**ledger 是判断**（这次算不算兑现、信任怎么变）。两者不混写，避免污染会话历史与 KV cache。

---

## 3. 总体架构

```
                      ┌──────────────────────────────────────────┐
                      │                dsh-promise                │
                      │                                          │
  model ──tools──▶    │  declare / select / settle / inspect /    │
                      │  compose                                  │
                      │        │                                  │
                      │        ▼                                  │
                      │  ┌───────────┐   ┌───────────────┐        │
                      │  │  Router   │◀──│ Trust Engine  │        │
                      │  └───────────┘   └───────▲───────┘        │
                      │        │                 │                │
                      │        ▼                 │                │
                      │  ┌───────────┐   ┌───────┴───────┐        │
                      │  │  Policy   │   │  Assessment   │        │
                      │  │  (L0–L3)  │──▶│   Engine      │        │
                      │  └───────────┘   └───┬───────┬───┘        │
                      │                      │       │            │
                      │              ┌───────▼──┐ ┌──▼─────────┐  │
                      │              │ L1 Rules │ │ Jev Client │  │
                      │              └──────────┘ └──┬─────────┘  │
                      │                              │            │
                      │  ┌───────────────────────────▼──────────┐ │
  session/event ────▶ │  │ Evidence Collector (工具/子代理信号) │ │
                      │  └──────────────────────────────────────┘ │
                      │  ┌──────────────────────────────────────┐ │
                      │  │ Ledger: JSONL + hash chain + snapshot│ │
                      │  └──────────────────────────────────────┘ │
                      └──────────────────────────────────────────┘
```

四条不变量（实现时要写进测试）：

1. **信任只能由已记录的评估改变**，路由/选择本身不改信任。
2. **账本是唯一真源**，信任快照可随时从账本重算并逐位相等。
3. **跨 agent 的承诺不可代写**：一次评估的 assessor 必须记录，且自评权重减半。
4. **评估失败不影响主流程**：Jev 超时/报错 → 记 `undetermined` + 证据缺口，绝不抛给会话。

---

## 4. 数据模型

所有记录带 `schemaVersion`，保证未来迁移。

```ts
type Capability = string            // 稳定标识，如 "code-review.security"、"research.brief"
type AgentId = string               // 如 "preset:reviewer"、"tool:web_search"、"subagent:spawn/*"、"compose:research-pack"

interface PromiseRecord {
  id: string
  agent: AgentId
  capability: Capability
  statement: string                 // 人可读的承诺句
  qos: {
    minQuality?: number             // 0..1，对应绝对质量
    maxLatencyMs?: number
    requiredFormat?: 'json' | 'markdown' | 'diff' | 'text'
    maxCostUsd?: number
  }
  assessment: {
    policy: 'L0' | 'L1' | 'L2' | 'L3' | 'auto'
    sampleRate?: number             // L2 用，默认 0.15
    passThreshold?: number          // noul p ≥ 此值 → fulfilled，默认 0.7
    failThreshold?: number          // 默认 0.3
    minConfidence?: number          // 低于此置信度 → undetermined，默认 0.5
    rubric?: string[]               // 可选，自定义档位描述
  }
  signals?: {                        // 自动证据采集（L1）
    tool?: string[]                 // 例如 ['web_search']
    errorsAreViolations?: boolean
  }
  status: 'active' | 'probation' | 'suspended' | 'retired'
  version: number
  declaredBy: AgentId
  createdAt: string
  updatedAt: string
}

interface JobRecord {
  id: string
  promiseId: string
  agent: AgentId
  capability: Capability
  request: string                   // 需求/输入的摘要
  constraints?: Record<string, unknown>
  level: 0 | 1 | 2 | 3
  levelReason: string
  openedAt: string
  closedAt?: string
  outcome?: 'success' | 'failure' | 'abandoned'
  outputRef?: string                // 会话事件序号 / 文件路径 / 内联文本哈希
  latencyMs?: number
  costUsd?: number
}

interface AssessmentRecord {
  id: string
  jobId: string
  assessor: AgentId                 // 规则引擎 = "system:rules"；Jev = "judge:jev"
  method: 'rules' | 'jev' | 'user' | 'downstream' | 'self'
  level: 0 | 1 | 2 | 3
  verdict: 'fulfilled' | 'violated' | 'undetermined'
  layers: {
    absolute?: number               // 0..1
    relative?: number               // 0..1（已在 0.5 处表示「符合预期」）
    process?: number                // 0..1
  }
  confidence: number                // 0..1，来自 Jev 或规则确定性
  failureMode?: 'input' | 'capability' | 'process' | 'spec' | 'tool' | 'none' | 'other'
  rationale: string                 // 短，可审计
  evidence: { eventSeqs?: number[]; outputHash?: string; truncated?: boolean }
  raw?: unknown                     // Jev 原始答案（可选，默认不落盘）
  createdAt: string
}

interface TrustRecord {
  agent: AgentId
  capability: Capability
  assessor: AgentId
  score: number                     // 0..1，先验 0.5
  mass: number                      // 有效证据量（衰减后的 Σ权重）
  evidenceCount: number
  updatedAt: string
  history?: Array<{ at: string; delta: number; reason: string }>  // 仅最近 N 条
}

interface CompositionRecord {
  id: string
  name: string
  external: PromiseRecord           // 对外的唯一承诺
  children: Array<{ agent: AgentId; capability: Capability; weight: number }>
  createdAt: string
}
```

账本事件：

```ts
type LedgerEvent =
  | { t: 'promise/declared';   promise: PromiseRecord }
  | { t: 'promise/updated';    promise: PromiseRecord }
  | { t: 'job/opened';         job: JobRecord }
  | { t: 'job/closed';         jobId: string; outcome: string; latencyMs?: number; outputRef?: string }
  | { t: 'assessment/recorded'; assessment: AssessmentRecord; trustDelta?: Array<{ agent: AgentId; capability: Capability; before: number; after: number }> }
  | { t: 'breach';             jobId: string; promiseId: string; action: 'probation' | 'suspend' | 'none'; reason: string }
  | { t: 'composition/declared'; composition: CompositionRecord }
```

每条事件带 `{ seq, at, prevHash, hash }`，`hash = sha256(prevHash + canonicalJson(payload))`。落盘 `ledger.jsonl`，每 N 条写一次 `snapshot.json`（含 seq、hash、trust 表、promise 表）。启动时 snapshot + 尾部重放，并校验链。

---

## 5. 信任模型（可重算，不做黑箱）

### 5.1 单条证据的权重

```
w = levelWeight(level) × confidence × assessorWeight(method)
```

- `levelWeight`：L1 = 0.35，L2 = 0.7，L3 = 1.0，L0 = 0（只记事实，不改信任）
- `assessorWeight`：rules 1.0，jev 1.0，user 1.0，downstream 0.8，**self 0.5**（自己评估自己打折）
- `confidence`：**映射为 `0.5 + 0.5 × conf`**，不是直接用 conf。实测 Jev 在明显正确的样本上也会给低 conf（0.25），直接用会把好证据压得过轻；映射后权重落在 0.5–1.0。
- `noul` 问题**没有 conf 字段**（实测），只有概率 p。因此 noul 只做阈值判定，不参与置信度门槛；可靠性用重复采样的稳定性衡量（见 §6.3）。

### 5.2 聚合：加权均值 + 时间衰减

对每个 `(agent, capability, assessor)` 维护 `score, mass`：

```
Δt  = 距上次更新
decay = 0.5 ^ (Δt / halfLife)          // halfLife 默认 14 天
mass' = mass × decay
score' = (score × mass' + s × w) / (mass' + w)
mass'' = mass' + w
```

- 新代理：`score = 0.5, mass = 0`（对应文章里的「未知」起点）
- 衰减让 `mass → 0` 时分数自然回落到 0.5，也就是「久未验证 = 重新变得未知」
- 从账本重算时按同一公式顺序重放即可得到完全一致的值（这就是可审计性）

### 5.3 跨评估者聚合

```
trust(a, c) = Σ_assessor score_i × mass_i / Σ_assessor mass_i
```

保留每个 assessor 的分量，`promise_inspect` 可展开；不承诺「唯一权威分数」。

### 5.4 用于排序的置信下界

单点估计会把「一次好运」当成可靠。排序用 Wilson 下界：

```
p̂ = trust, n = effectiveEvidence(mass)   // mass 映射成伪计数，如 n = mass / avgWeight
lower = wilsonLowerBound(p̂, n, z=1.0)
```

`n = 0` 时 `lower = 0.5`（先验），`n` 小的时候下界明显低于点估计 → 冷启动代理不会被一次高分推上第一名。

### 5.5 探索项

```
explore = c × sqrt(ln(totalJobs + 1) / (mass + 1))     // c 默认 0.08
```

只对 `mass < minEvidence` 的活跃承诺加成；一旦有足够证据就自然消失。这是为了防止「富者愈富」和证据饥饿。

---

## 6. 评估引擎

### 6.1 分层（L0–L3）与 Planner

`level` 不靠模型自报，由确定性函数决定，保证可测：

| 输入 | 取值 | 对 level 的影响 |
|---|---|---|
| 风险等级 `riskTier` | 0 低（读、查） / 1 中（写文件、发消息） / 2 高（部署、外部提交） / 3 不可逆 | 0→L0/L1，1→L1/L2，2→L2/L3，3→必须 L3 |
| 可逆性 | reversible / irreversible | irreversible 至少 L3 |
| 价值 | low / high | high 至少 L2 |
| 证据量 | mass | mass < 冷启动阈值时 +1 级 |
| 承诺声明 | `assessment.policy` | 取 max(声明, 计算值) |
| 预算 | `maxJevCallsPerTurn` | 超预算降级并记录 `levelReason` |

输出 `{ level, reasons[] }`，直接回显给调用者——**路由与评估都必须可解释**。

### 6.2 L1 规则层（零成本，永远开）

从 `session/event` 自动采集，或由 `settle` 传入：

- 工具错误 / 超时 / 非零退出 / 被拒绝的审批
- 输出格式断言（JSON 可解析、必须含章节、字数范围、diff 可应用）
- 延迟 vs `qos.maxLatencyMs`
- 空输出、截断、重复调用同一工具 N 次（≈ 过程异常）
- 进程质量弱信号：是否出现澄清提问、是否显式标注不确定/局限、是否遵守格式

L1 可以**否决**：硬规则失败 → `violated`（confidence 1.0），语义层不再推翻它。

### 6.3 L2 / L3：Jev 类型化评估（原子问题 + 引擎聚合）

原则：**Jev 只回答原子问题，不做复合判断，也不做算术。** 复合判断与聚合由引擎完成——可审计、可回归、可替换评估器。

```jsonc
POST https://api.typesafe.ai/v1/systemone
{
  "state": {
    "promise": { "capability": "...", "statement": "...", "qos": { ... } },
    "request": { "text": "…", "constraints": { ... } },
    "output":  { "text": "…（截断后）…", "format": "diff", "bytes": 18420 },
    "evidence": [
      { "id": "e1", "kind": "check", "name": "tests", "ok": true },
      { "id": "e2", "kind": "rule",  "name": "scope", "ok": true },
      { "id": "e3", "kind": "tool",  "name": "bash", "ok": true },
      { "id": "e4", "kind": "note",  "text": "无法验证 payments 时区边界" }
    ],
    "process": { "toolCalls": 23, "errors": 1, "retries": 1, "durationMs": 372000 }
  },
  "questions": {
    "addresses_request": {
      "type": "noul",
      "instructions": "Does `output` actually implement what `request` asked for?",
      "criteria": { "true": "The requested behavior is present in the artifact", "false": "Missing, partial, or unrelated" }
    },
    "claims_contradicted": {
      "type": "noul",
      "instructions": "Does any item in `evidence` contradict a factual claim the agent makes in `output` about its work? Answer false when `evidence` is empty.",
      "criteria": { "true": "At least one factual claim is contradicted by evidence", "false": "No factual claim is contradicted" }
    },
    "absolute_quality": {
      "type": "score",
      "instructions": "How useful is `output` to the requester, ignoring how hard the input was?",
      "criteria": ["Unusable", "Major rework needed", "Usable with edits", "Good", "Excellent, ship-ready"]
    },
    "input_quality": {
      "type": "score",
      "instructions": "How clear, complete and internally consistent is `request`?",
      "criteria": ["Unusable / contradictory", "Missing key info", "Adequate", "Clear", "Complete and precise"]
    },
    "process_quality": {
      "type": "score",
      "instructions": "Did the agent act professionally: flag ambiguity/conflicts, state limits, follow the required format?",
      "criteria": ["Dishonest or无视 constraints", "Sloppy", "Acceptable", "Careful", "Exemplary: surfaced limits and conflicts"]
    },
    "failure_mode": {
      "type": "choice",
      "instructions": "If `output` falls short, what is the dominant cause?",
      "criteria": {
        "none": "No meaningful shortfall",
        "input": "The request itself was deficient",
        "capability": "The agent lacked the ability",
        "process": "The agent was careless or cut corners",
        "spec": "The promise/acceptance criteria were ambiguous",
        "tool": "A tool or dependency failed"
      }
    },
    "unmet_requirement": {
      "type": "choice",
      "instructions": "If `output` falls short, which specific requirement from `request` is unmet?",
      "criteria": { "req_1": "…", "req_2": "…", "none": "All requirements met" }
    }
  }
}
```

映射：

```
absolute = score_abs / 4
process  = score_proc / 4
bucket   = round(score_in)                                   // 输入质量分档 0..4
baseline = median(absolute | capability, bucket)              // 从账本历史取；冷启动用先验表
relative = clamp(0.5 + (absolute - baseline) / 2, 0, 1)       // 0.5 = 符合该输入质量下的预期
```

**刻意删掉了 `expected_quality` 这个反事实问题**：实测它在「清晰输入」上是 1.33、在「模糊输入」上反而升到 1.54，且与 `absolute_quality` 高度贴合（1.51 vs 1.54）——不可靠。改成数据驱动基线，越跑越准，且完全可复算。

三值裁决（引擎算，不是模型算）：

```
rules violated                                  → violated (conf 1.0)
p_addr ≥ 0.70 ∧ p_contradicted ≤ 0.30           → fulfilled
p_addr ≤ 0.30 ∨ p_contradicted ≥ 0.70            → violated
p_addr ∈ (0.30, 0.70) 或 两次采样跨阈值           → undetermined（不更新信任，证据缺口 +1）
```

- `noul` 没有 `confidence` 字段，所以**不设置信度门槛**；改用「边界双采样」：p 落在 `[0.55, 0.85]` 时再采一次，两次数值跨过阈值则判 `undetermined`，否则取均值。
- `score` 的 `confidence` 只用于证据权重（§5.1 的映射），不用于否决；实测明显正确的样本 conf 也只有 0.25。
- 阈值按 capability 可配，由 goldenset 校准；`unmet_requirement` 的置信度用于选择是否把它作为审计结论展示（≥0.6 才展示），不参与裁决。

### 6.4 成本控制

- 默认 L1；L2 默认 `sampleRate=0.15`（且每个 agent 每小时有下限抽样，防止零证据）
- L3 每轮最多 1 次，超预算降级并写明 `levelReason`
- 状态裁剪：输出只送头部 + 尾部 + 结构摘要，`maxStateBytes` 默认 24KB
- 评估异步化：`settle` 同步返回 L1 结果，L2/L3 默认 `await`（因为要写回 verdict）；但支持 `async=true` 先返回 `pending`，完成后写入账本

---

## 7. 路由与结算协议

### 7.1 三段式：declare → select → settle

```
promise_select(capability, need, constraints?, riskTier?)
   → { jobId, candidates: [ {promiseId, agent, trust, lower, qosFit, reasons[],
                             invoke: { kind: 'subagent'|'tool'|'workflow', hint } } ],
       recommended }
   → 模型据此「接受某一个承诺」，然后执行
promise_settle(jobId, outcome, output?, latencyMs?, signals?)
   → settlement report（见下）
```

这里刻意不做「插件代替模型调用工具」：DSH 的工具调用由模型发起，插件强行代跑会破坏会话语义和审批流。插件负责**匹配与记账**，执行仍走 DSH 原生路径。

### 7.2 排序公式

```
eligibility: status ∈ {active, probation} ∧ capability 匹配 ∧ QoS 硬约束满足
score = 0.55 × trustLower
      + 0.25 × qosFit
      + 0.10 × costFit
      + 0.10 × explore(仅低证据)
      − breachPenalty
```

输出**必须**带 `reasons`（例如「trust 0.78（lower 0.69，证据 42 次）」「延迟承诺 5min 满足 3min 预算」）。

### 7.3 结算报告（用户可见的「带可信度的结果」）

```
承诺结算 · research.brief
  执行者   preset:research-pack（v3）
  承诺     10 分钟内产出 ≤2000 字、带来源、结论已核查
  评估     L2 · Jev · 置信 0.86
          绝对 0.75  相对 0.62  过程 0.90   → 兑现
  信任     0.71 → 0.73（证据 42 → 43）
  备注     输入质量偏低（0.40），相对表现优于预期
  账本     #a13f…（可审计）
```

违约时追加：`违约归因`、`降级动作`、`备选 top2`、`下次要求 L3`。

---

## 8. 违约处理

```
violated 且（信任跌幅 ≥ 0.05 或 lower < probationFloor=0.45）
   → status = probation，接下来 K=3 次强制提升一级评估
   → 连续 3 次 fulfilled → 回到 active
   → probation 期间再次 violated → suspended（不再参与路由，保留历史）
```

所有动作写入 `breach` 事件；`promise_inspect` 可查完整降级链路。**不做自动重试**：重试是编排决策，插件只提供备选与理由。

---

## 9. 超级代理

```ts
promise_compose({
  name: 'research-pack',
  external: { capability: 'research.brief', qos: {...}, statement: '...' },
  children: [
    { agent: 'preset:searcher', capability: 'research.search', weight: 0.3 },
    { agent: 'preset:analyst',  capability: 'research.analyze', weight: 0.3 },
    { agent: 'preset:writer',   capability: 'research.write',   weight: 0.3 },
    { agent: 'preset:checker',  capability: 'research.verify',  weight: 0.1 }
  ]
})
```

- 外部评估只针对 `compose:research-pack`，**不会**把子代理的分数直接抄成外部信任
- `compositionHealth` = Σ weight × min(child.trustLower, child.trust) 的加权，明确标注为 **estimate**
- 内部结算（子代理 settle）只更新子代理信任，并作为外部评估的参考证据
- 替换子代理只要外部承诺不变，外部调用方无感——这正是文章里「封装承诺而非封装编排」的可执行版本

---

## 10. DSH 接入点（具体到 API）

| 位置 | 用法 |
|---|---|
| 工具 | `ctx.tools.register(defineTool({...}))` × 5 |
| 系统提示词 | `ctx.systemPrompt.section({ name: 'promise:protocol', order: 1200, text })` —— **静态文本**，只放协议与工具用法，不放动态信任数据（避免 KV cache 失效） |
| 事实来源 | `ctx.on('session/event', (session, event) => ...)`：`tool/call`、`tool/result`、`turn/end`、`assistant/message` |
| 调用者身份 | `exec.agent` / `exec.agent.session` |
| 持久化 | 自管 JSONL（`config.dataDir`，默认 `$DSH_HOME/promise`），不依赖 `dsh-storage` 是否挂载 |
| 配置 | `schemastery` Config，全部字段有默认值；`enabled` 一键关闭 |
| 日志 | 宿主 logger，评估失败只 warn |
| 包形态 | `@dsh/promise`（本地包名 `dsh-promise`），ESM，`main: lib/index.js`，导出 `name/apply/inject/Config` |

工具清单（v1，5 个）：

| 工具 | 作用 | 关键输出 |
|---|---|---|
| `promise_declare` | 声明/更新承诺（幂等，带 version） | promiseId + 校验错误 |
| `promise_select` | 路由，创建 job | 候选排序 + 推荐 + jobId |
| `promise_settle` | 结算 + 评估 + 改信任 | verdict、三层分、信任增量、违约动作 |
| `promise_inspect` | 查信任 / 承诺 / 账本 / 违约 | 结构化报告（文本摘要） |
| `promise_compose` | 声明超级代理 | compositionId + 健康估计 |

自动采集（尽可能全面，不依赖模型自报）：

| 来源 | 采集内容 | 用途 | 归属方式 |
|---|---|---|---|
| `session/event`（含子会话） | `tool/call`、`tool/result`、`assistant/message`、`turn/end` | 过程证据、耗时、失败重试、自述与事实一致性 | 父会话 job ↔ 子会话（经 subagent 工具结果里的 `subagentId` 关联） |
| `tool/result.error` / 退出码 | 失败名、错误原因 | 工具类承诺 L1、`errorsAreViolations` | `signals.tool` 匹配 |
| `assistant/message` 文本 | 风险标注、未完成声明、澄清提问 | 过程质量（L1 弱信号 + Jev 输入） | 当前 turn |
| `feedback/message-put` | like/dislike、分类、备注 | `user` 评估证据 | assistant 消息 → turn → job |
| `turn/end` | 轮次关闭 | 自动结算触发点 | 当前 job |
| 显式 `promise_settle` | diff/产物引用、预算 | 覆盖并补全自动结果 | jobId |

自动结算规则：

1. 有 `jobId`（显式 select 过）→ `turn/end` 自动 settle（L1），语义层按 planner 抽样；之后显式 settle 覆盖并补全，不重复计分。
2. 无 `jobId` → 按 capability 匹配（`signals` + 模型声明 + 工具特征）；归属置信度不足 → 进 `unattributed` 桶，**只统计不改信任**，供 `promise_inspect` 复盘。
3. 同一 `(jobId, turn)` 的重复结算幂等去重。
4. 归属置信度低于阈值时只记 observation，防止错误归属污染信任——**这是全面采集的前提**。

这样「全面」不等于「乱记」：采集面尽量宽，写入信任的入口尽量窄。

---

## 11. 配置（示例）

```yaml
- id: promise
  name: 'dsh-promise'
  config:
    enabled: true
    dataDir: !!js "require('node:os').homedir() + '/.dsh/promise'"
    ledger:
      snapshotEvery: 200
      compactAfterDays: 180
    trust:
      prior: 0.5
      halfLifeDays: 14
      explorationBonus: 0.08
      minEvidence: 5
      probationFloor: 0.45
    assessment:
      defaultLevel: 1
      sampleRate: 0.15
      maxJevCallsPerTurn: 2
      minConfidence: 0.5
      passThreshold: 0.7
      failThreshold: 0.3
      maxStateBytes: 24576
    jev:
      enabled: true                 # 无 key 自动退化为 L1
      baseUrl: 'https://api.typesafe.ai/v1/systemone'
      apiKeyEnv: 'TYPESAFE_API_KEY'
      model: 'jev-1.13.0'           # 可选；省略由服务端决定
      timeoutMs: 20000
    redaction:
      stripPatterns: ['sk-[A-Za-z0-9]{16,}', 'ghp_[A-Za-z0-9]{20,}', 'Bearer\\s+\\S+']
      includeRawAnswers: false
```

---

## 12. 测试与验收

**单元测试（node:test，无网络）**
- 信任：EMA 重算一致性、衰减回 0.5、跨评估者聚合、Wilson 下界单调性
- 路由：冷启动不吃亏、高信任不被一次好运推顶、硬约束过滤、reasons 非空
- Planner：风险 × 可逆 × 价值 × 证据 → level 全表
- 裁决：规则否决优先、置信度取最小、undetermined 不改信任
- 账本：哈希链校验、snapshot + replay 逐位一致、损坏检测
- Superagent：外部/内部信任不串味、替换子代理外部无感
- Jev adapter：mock fetch 校验请求体、超时、错误码、截断

**集成（fake ctx）**
- 插件加载注册 5 个工具 + 1 个 prompt section，无重名
- `session/event` 监听器幂等、异常不外泄
- 关闭开关后零副作用

**手工验收**
- 在独立 profile（`dsh --profile promise-demo`）里跑 20 个跨类型任务，检查：路由理由、账本完整、信任轨迹符合预期、单轮 Jev 调用 ≤ 预算、关掉 Jev 后仍可 L1 运行

**验收标准（可测）**
1. 任一路由决策可仅凭账本复现
2. 任一信任值可从账本重算得到相同结果
3. 评估子系统故障时，会话成功率不受影响
4. 单轮额外 token 成本 = 0（L0/L1）；L2 抽样时可控上限

---

## 13. 阶段与风险

**阶段**
- P0：包 + 引擎 + 单测 + 文档 + 安装脚本（本次交付）
- P1：shadow 模式（只记账不改路由，冷启动积累数据）
- P2：advisory（路由读信任，但模型可覆盖）
- P3：gated（高风险任务 L3 门禁；需用户显式开启）

**风险与对策**

| 风险 | 对策 |
|---|---|
| 信任被刷：代理自评/伪造输出 | 自评权重 0.5；L2/L3 只看 session 真实 artifact；抽样审计；评估者身份入账 |
| 选择偏差（富者愈富） | 探索项 + 低证据强制抽样 + 衰减 |
| Jev 判断不可靠 | 规则可否决；置信度低于阈值记 undetermined；不把 judge 当真理 |
| 提示注入经 state 进入 judge | state 当数据不当指令；截断 + 红action；不使用 judge 输出直接驱动工具 |
| 隐私/外发 | 默认 L1，本地零外发；Jev 需显式配置 key；redaction 默认开 |
| 与 DSH 版本不匹配 | peerDependencies 固定 0.2.x；engines.dsh 声明 |
| 状态并发写 | 单进程串行队列 + 原子写（temp+rename）+ 启动时链校验 |

---

## 14. 已确认决策（2026-11-10）

1. **Jev 默认开启**；无 API key 时自动退化为 L1，并在首次日志里提示一次。
2. **五个工具**：`promise_declare / select / settle / inspect / compose`，保持拆分（`compose` 不做成 `declare` 的特例，因为它的外部/内部信任语义不同）。
3. **账本自管**：`$DSH_HOME/promise/*.jsonl` + snapshot。前提是单进程串行写、原子落盘、可重放；若将来需要跨进程共享，再评估接 `dsh-storage`。
4. **自动采集尽可能全面**（见 §10）：子会话、工具结果、assistant 自述、`feedback/*`、`turn/end` 全部采集；但**写入信任的入口保持窄**——归属置信度不足只进 `unattributed`，不改信任。
5. **不改 profile**：交付插件包 + 测试 + 文档 + 安装脚本，由你手动安装/重启验证。

---

# 附录 E：Jev 适配性评估

## E.1 结论

**适合做「语义判断层」，不适合做「验证层」。**

- 适合：需求贴合、过程诚实、审查质量、能力分类、任务筛选——即「分类 / 打分 / 路由」这类 System One 的本职工作。
- 不适合：判断代码是否正确、schema 是否合法、算术是否对——这些有更强的 oracle（编译器/测试/校验器）。
- 不适合单独决定高风险 verdict：它给概率，不给担保；最终裁决必须由「规则 + oracle + 概率」共同得出。

一句话：**把 Jev 当「校准过的评分器」，不要当「裁判」。**

## E.2 为什么适合（五点）

1. **类型化输出，没有解析层**。`noul / score / choice` 直接进代码，不存在「模型多说了一句话导致 JSON 解析失败」这类运维问题。
2. **`confidence` 是可用信号**。自由文本 judge 通常只给结论，不给可用置信；这里可以直接当证据权重、当「undetermined」的判据。这是本设计里最有价值的一条。
3. **成本量级成立**。24KB state ≈ 6k tokens，按 $0.042/1M 计约 **$0.00025/次**；1000 次/月约 $0.25。评估成本从「要不要做」变成「做多少」。
4. **一问多题、同一 state**。三层评分和归因共享同一上下文，避免多次调用之间的不一致。
5. **没有自由文本 → 注入面更小**。它不能被执行指令、不会输出代码，减少了「被评估内容反过来操纵评估器」的经典风险（判断本身仍可被表面特征影响，见 E.3）。

额外适合的用法（超出「评估」本身）：
- `promise_select` 未指定 capability 时，用 `choice` 做能力分类；
- 用 `noul` 做 `is_substantive` 预筛：低价值请求直接 L0，省掉后续一切开销（对应官方文档的 "screen with a Noul first" 模式）。

## E.3 为什么不够（六点，以及对策）

| # | 问题 | 影响 | 对策 |
|---|---|---|---|
| 1 | 不是 oracle | 看不到运行时行为，测试通过但逻辑错它也可能给高分 | 代码类任务以 tests/typecheck 为准；Jev 只判「需求贴合 + 过程」 |
| 2 | System One 推理深度有限 | 复合问题（「整个方案对不对」）不可靠 | **原子问题 + 引擎聚合**（§6.3 已改） |
| 3 | 32k 上下文 | 长会话、大 diff 放不下 | 结构化 state + 分片 + `truncated` 标记并压低置信上限 |
| 4 | 不给理由 | 审计缺「为什么」 | `unmet_requirement` choice 指认未满足的具体条款；争议样本升级推理模型写理由 |
| 5 | 反事实不可靠 | 「称职代理会得几分」容易退化成复制绝对分 | 删掉该问题，改数据驱动基线（§6.3 已改） |
| 6 | 校准是宣称，不是保证 | 域偏移（代码/中文/长文本）后概率可能失真 | goldenset 校准 + 熔断（E.6） |

补充两条工程风险：

- **供应商依赖**：单点 API、key 管理、版本漂移（`jev-1.13.0` → 未来版本）、价格变动。→ Assessor 接口 + 可回退（E.5）。
- **数据外发**：代码 diff 出境是真实合规问题。→ 默认 redaction + 字节上限；企业可只开 `chat-judge`（本地模型，经 `ctx.llm`）或 `rules-only`。

## E.4 由此对设计做的修正

1. **原子化提问**：不再问「是否兑现」这种复合问题，改问 `addresses_request` / `claims_contradicted`，复合判断交引擎。
2. **相对表现改基线法**：删除 `expected_quality` 反事实问题，`relative = f(absolute, capability, input_quality_bucket)`，基线从账本历史取中位数。
3. **条款归因**：`unmet_requirement` 让每次评估能回答「哪条承诺没兑现」。实测比「哪条证据最决定性」可靠得多（0.94/conf 0.91 vs 0.47/conf 0.28）。
4. **Assessor 接口**：Jev 只是默认实现，不是唯一实现。
5. **Judge 健康监控**：评估器本身要有准确率、false-pass、漂移与熔断，坏了就停止用 Jev 更新信任。

## E.5 Assessor 接口

```ts
interface Assessor {
  readonly id: 'jev' | 'chat-judge' | 'rules-only'
  assess(input: AssessInput, signal: AbortSignal): Promise<AssessmentResult>
}
```

| 实现 | 何时用 | 语义权重 | 备注 |
|---|---|---|---|
| `jev` | 默认（有 key） | 0.7 | 类型化、低延迟、低成本 |
| `chat-judge` | 数据不能外发 / Jev 争议升级 | 0.6 | 走 `ctx.llm`，JSON schema 约束；更慢更贵，但可写理由 |
| `rules-only` | 无 key / 熔断 / 离线 | 0.9（但只有 A/B 层） | 永远可用，保证系统不空转 |

配置 `assessors: ['jev', 'rules-only']` 为有序回退链；每次评估记录 `assessor`，信任本就按评估者分离，回退不会污染历史。

## E.6 适配性验收集（一周内可完成）

用 100 条历史 job（3 个 capability × 中英双语），人工标注 verdict 与三层分，然后测：

| 指标 | 含义 | 通过线 |
|---|---|---|
| **false-pass rate** | 违约被判成兑现（最贵的错误） | ≤ 5% |
| false-fail rate | 兑现被判成违约 | ≤ 10% |
| Cohen's κ | 与人工标注的一致性 | ≥ 0.6 |
| ECE | 置信度校准误差 | ≤ 0.15 |
| 分 capability 误差 | 代码 vs 文本 vs 检索 | 任一不劣于总体 -10% |

A/B 三组：Jev / chat-judge / rules-only，同一批样本。**不通过就不让 Jev 单独决定 verdict**，退化为辅助信号（只调幅度，不判生死）。这就是文章提到的「评估本身也要被评估」的具体落地。

## E.7 不该用 Jev 的场景

- 有强 oracle 的：代码正确性、schema 合法性、算术、格式——用 checker。
- 不可逆且无法人工复核的：要人签，不要让概率背书。
- 数据不能出境的：用本地 `chat-judge` 或纯规则。
- 交付物本身要求「解释」的：Jev 不产文本，理由得另找。

## E.8 我的判断

Jev 不是这套体系的充分条件，但它是**让「评估默认化」在经济上成立的那块拼图**。真正决定这套系统好不好用的，仍然是三件事：**state 的组装质量、问题的原子化程度、以及评估器自身的校准**。Jev 让第三件事第一次变得可测量。


---

# 附录 A：UI 呈现

## A.1 原则

1. **没有承诺就没有 UI**：未声明任何 promise 的会话里，插件不渲染任何东西，不占头部槽位。
2. **渐进披露**：卡片（一眼）→ 面板（一会话的信任与违约）→ 账本（一次结算的全部证据与哈希）。
3. **每个数字都带出处**：`0.73` 必须同时给「证据 42 次 / 评估者 jev / 置信 0.86」；单独一个分数不许出现。
4. **estimate 必须标注**：超级代理健康度、相对表现这类推断，用「估计」样式，不与实测同权。
5. **不打断流式输出**：所有附加 UI 都在工具卡片完成态或头部面板里，不插入 assistant 消息流。

## A.2 五个呈现面

### 面 1：工具卡片（v1 就能做，零客户端代码）

用 `defineTool` 的 `presentCall` / `presentResult`，复用 DSH 现有 `generic` 卡片：

`promise_select` 调用中：

```
┌ 选择承诺 · code.change ───────────────────────────┐
│ 风险 2 · 预算 30min · 需要 L3                       │
│ 候选 3 个，按信任下界排序                            │
│  1. preset:developer      0.73 (lower 0.66) ⭐      │
│  2. preset:developer-fast 0.68 (lower 0.55)         │
│  3. compose:ci-fixer      0.55 (lower 0.41, 估计)   │
└────────────────────────────────────────────────────┘
```

`promise_settle` 完成后：

```
┌ 承诺结算 · code.change ─────────────────────────────┐
│ preset:developer v4          L3 · Jev · 置信 0.86    │
│ 绝对 0.75   相对 0.68   过程 0.90        ✅ 兑现      │
│ 检查  tests ✅  typecheck ✅  scope ✅  secrets ✅    │
│ 信任  0.71 → 0.73（证据 41 → 42）                    │
│ 账本  #a13f…   [查看证据]                            │
└─────────────────────────────────────────────────────┘
```

违约时同一张卡换红色边：

```
│ ❌ 违约 · 归因 process（测试被弱化）                  │
│ 动作：进入 probation（3 次强制 L3）；备选 preset:x    │
```

这三张卡已经满足文章第 07 篇想要的「带可信度证据的结果」，且成本极低——**v1 只做这个**。

### 面 2：会话头部 Promise 面板（v2，客户端插件）

DSH 的客户端插件机制足够做这个：参照 `dsh-client-ui-jobs`，`ctx.slots.inject('conversation.session.header.actions', ...)` 在会话头部加一个触发器，点开是固定定位的弹出层。数据走 host 侧 Remote（`promise.list` / `promise.follow` 只读流），不在客户端持有第二份状态。

面板内容：

```
本会话承诺
  code.change     preset:developer   0.73  ↑   L3  ✅ ✅ ✅
  research.brief  compose:research-… 0.61  —   L2  ✅ ⚠️
未结算 1 条 · 违约 0 条 · 今日 Jev 2/2 次（预算内）
[展开账本]
```

展开后是时间线：`select → job → settle → trust Δ`，每条可跳到会话事件序号。**只读**——面板不提供任何「手动改信任」的入口，否则信任立刻失去意义。

### 面 3：设置页

一行「Promise 协议」：开关、Jev key 状态（只显示是否配置，不显示值）、评估预算、抽样率、数据目录、导出账本。沿用 `dsh-client-ui-settings-*` 的页面形态。

### 面 4：交付物报告

`promise_inspect(format: 'markdown')` 产出可直接 `present` 的报告：能力 × 代理的信任矩阵、本周结算数、违约归因分布、证据缺口、被抽样审计的条目。这是给人看的，也是给下一轮 prompt 用的（可选）。

### 面 5：CLI / CI 报告

包内带一个只读 `bin`（如 `dsh-promise report --ledger <dir> --since 7d`），输出 Markdown/JSON。好处：CI 可以拿「某 capability 的信任下界低于阈值」当发布门禁，不需要宿主在线。

## A.3 不做什么

- 不做「实时信任仪表盘」：信任变化是低频事件，实时刷新只会制造噪声和流中断。
- 不做「手动打星改信任」：反馈走 `dsh-message-feedback` 的 `feedback/message-put`（like/dislike）作为一条 `user` 评估证据，而不是直接改分。
- 不在消息流里插系统提示：所有状态都在卡片/面板里。

---

# 附录 B：一个典型的 PromiseAgent 工作流（Developer Agent）

## B.1 什么算一个好承诺

四条硬标准，缺一条这个承诺就不可用：

1. **可证伪**：能被某条证据判成假。「我写出高质量代码」不行；「`pnpm test` 退出码 0」行。
2. **有范围**：什么条件下承诺、什么条件下不承诺（例如「需求必须包含一个失败测试或明确复现步骤」）。
3. **有证据源**：每条承诺对应一个可执行的检查、一条规则、或一个 Jev 问题。
4. **有违约后果**：违反后信任怎么变、是否降级、谁接。

反例（真实系统里最常见）：「我是一名资深工程师，能完成各种开发任务。」——不可证伪、无范围、无证据源。

## B.2 Developer Agent 应该承诺什么

一个 `preset:developer` 通常该持有 **3 个承诺**，而不是一个笼统的「会写代码」：

```jsonc
// 1) 改代码
{
  "capability": "code.change",
  "statement": "给定一个明确需求或一个失败测试，我交付一个最小 diff：既有测试全绿、为新行为补测试、只改需求涉及的模块，并如实报告未解决的风险。",
  "qos": {
    "requiredFormat": "diff",
    "minQuality": 0.7,
    "maxFilesChanged": 12,
    "maxLatencyMs": 1800000
  },
  "checks": [
    { "id": "tests",     "run": "pnpm test -- --run",      "expect": { "exit": 0 }, "timeoutMs": 600000 },
    { "id": "typecheck", "run": "pnpm tsc -p . --noEmit",  "expect": { "exit": 0 }, "timeoutMs": 300000 }
  ],
  "rules": [
    { "id": "scope",    "kind": "files-within", "globs": ["src/**", "test/**"] },
    { "id": "new-test", "kind": "diff-touches", "globs": ["test/**", "**/*.test.ts"] },
    { "id": "secrets",  "kind": "no-match",     "pattern": "sk-[A-Za-z0-9]{16,}" }
  ],
  "assessment": { "policy": "L2", "sampleRate": 0.3, "passThreshold": 0.7, "minConfidence": 0.55 },
  "signals": { "tool": ["bash", "write", "edit"] }
}
```

```jsonc
// 2) 审代码
{
  "capability": "code.review",
  "statement": "对给定 diff 输出结构化审查报告：每条结论带文件:行号与严重级别；不臆测未读过的代码；无发现时明说。",
  "qos": { "requiredFormat": "json", "minQuality": 0.7, "maxLatencyMs": 600000 },
  "rules": [
    { "id": "schema", "kind": "json-schema", "schema": { "findings": "array" } },
    { "id": "line-refs", "kind": "all-findings-have", "field": "file:line" }
  ],
  "assessment": { "policy": "L3", "passThreshold": 0.75 }
}
```

```jsonc
// 3) 修失败测试
{
  "capability": "code.fix-failing-test",
  "statement": "给定一个失败的测试标识，我修到它通过，且不让同套件其他测试变红；若根因在测试本身，我说明并给出证据。",
  "qos": { "requiredFormat": "diff", "maxLatencyMs": 1200000 },
  "checks": [
    { "id": "target-test", "run": "pnpm test -- -t \"<test name>\"", "expect": { "exit": 0 } },
    { "id": "suite",       "run": "pnpm test -- --run",             "expect": { "exit": 0 } }
  ],
  "assessment": { "policy": "L2", "sampleRate": 0.5 }
}
```

注意三件事：

- **能力切得比代理细**。同一个 agent 在 `code.change` 上 0.73、在 `code.review` 上可能只有 0.58；路由按能力选，不按 agent 选。
- **checks 是宿主执行的**（settle 时），不是相信子代理跑过。子代理自己的测试运行只算「过程证据」。
- **`qos.minQuality` 与 checks 分工不同**：checks 管硬门槛（可执行），minQuality 管语义质量（Jev）。

## B.3 一条完整链路（DSH 内）

```
用户：把 payments 的 flaky test 修掉
 │
 ├─ 主 agent 判定：capability = code.fix-failing-test，riskTier = 2（改代码，可回滚）
 │
 ├─ ① promise_select({capability, need, riskTier: 2, constraints:{maxLatencyMs: 1200000}})
 │     → jobId=J-8842
 │     → 候选：preset:developer 0.73 / preset:dev-fast 0.66 / compose:ci-fixer 0.55(估计)
 │     → 推荐 preset:developer，reasons 4 条
 │
 ├─ ② subagent({agent_preset: 'developer', prompt: '…'})        ← DSH 原生，不经过插件
 │     └─ 子会话：grep → read → edit → bash(pnpm test) → bash(pnpm test) 重试一次
 │        插件监听 session/event，静默采集：改了 3 个文件、2 次命令失败后成功、耗时 6m12s
 │
 ├─ ③ 子代理完成通知 → 主 agent 拿到 diff 与自述
 │
 ├─ ④ promise_settle({jobId: 'J-8842', outcome: 'success',
 │                    output: {diff, summary}, latencyMs: 372000})
 │     内部依次：
 │       a. 规则：scope ✅ / new-test ✅ / secrets ✅ / 文件数 3 ≤ 12 ✅
 │       b. 宿主执行 checks：target-test ✅  suite ✅   （独立评估者 system:checks）
 │       c. level=2 → Jev 评：需求贴合 0.81 / 过程 0.90 / 输入质量 0.70 / 失败归因 none
 │       d. 裁决 fulfilled（p=0.86, conf=0.79）
 │       e. 信任：preset:developer × code.fix-failing-test × judge:jev
 │               0.62 → 0.66（mass 8.4 → 9.4）
 │
 └─ ⑤ 结算卡返回给用户/主 agent：通过 + 三层分 + 信任增量 + 账本号
```

关键点：**主 agent 仍然是编排者**。插件只做「选谁、记什么、算多少」，不替模型执行。这样 DSH 的审批、沙箱、流式输出、会话历史全都不受影响。

## B.4 验证矩阵（Developer Agent）

| 承诺条款 | 验证手段 | 层级 | 执行者 | 伪造难度 |
|---|---|---|---|---|
| 既有测试全绿 | 宿主跑 `pnpm test` | L1 oracle | 宿主 | 高（无法篡改退出码） |
| 类型检查通过 | 宿主跑 `tsc --noEmit` | L1 oracle | 宿主 | 高 |
| 只改范围内文件 | `git diff --name-only` ⊆ glob | L1 rule | 规则 | 中（可先改后还原） |
| 补了新测试 | diff 是否触及测试文件 + 新增断言数 | L1/L2 | 规则 + Jev | 中（可写空测试） |
| 测试没被弱化 | 删除断言 / `.skip` / 只改期望值 → 标记；随机做 revert 检查 | L2 | 规则 + 宿主 | 高（revert 检查） |
| 真的实现了需求 | Jev：diff 是否满足需求（带置信） | L2/L3 | Jev | — |
| 过程诚实 | Jev process：标风险、说没做完、遇歧义提问 | L2 | Jev | — |
| 用户满意 | `feedback/message-put` like/dislike | 用户 | 人 | — |

## B.5 违约时会发生什么

```
如果 suite ✅ 但 target-test ❌（子代理声称修好了）：
  规则否决 → violated（confidence 1.0）
  归因 process（自述与事实不符）
  信任 -0.06，进入 probation（接下来 3 次强制 L3）
  返回：备选 preset:dev-fast；建议把「根因在测试本身」的路径显式声明出来
  账本记录 breach 事件，面板出现红色标记
```

---

# 附录 C：怎么 evaluate（细化）

## C.1 证据等级：能用执行验证的，绝不问模型

| 级别 | 证据 | 例子 | 权重 | 成本 |
|---|---|---|---|---|
| A | 可执行 oracle | 测试、类型检查、构建、`git apply`、schema 校验、回放 | 1.0 | 中（秒级） |
| B | 结构规则 | 文件范围、格式、引用完整、字数、必填字段 | 0.9 | ~0 |
| C | 语义判断（Jev） | 需求贴合、过程诚实、审查质量 | 0.7 | 低（1 次调用） |
| D | 人类反馈 | like/dislike、修改率 | 1.0（但稀疏） | 人 |
| E | 下游使用 | 下游代理是否直接可用、是否返工 | 0.6 | 间接 |

A/B 能否决；C 只调幅度；D/E 用来校准 C（见 C.6）。

这条排序是对文章的一个**重要修正**：它把「相对表现」从纯 LLM 判断变成「可执行基线 + 语义补充」。代码任务里，最好的 judge 是编译器。

## C.2 三层评分怎么落到具体任务

`code.change` 的 rubric（写进 promise 的 `rubric` 字段，Jev 的 criteria 直接用它）：

- **绝对质量**：0 不可用 / 1 大改 / 2 小改可用 / 3 好 / 4 可直接合入
- **输入质量**：需求是否含复现步骤、范围、验收标准、相关上下文
- **预期质量**：**同样的输入**交给一个「称职但非专家」的代理，通常产出什么档位
- **过程质量**：是否先定位再改、是否跑测试、是否报告风险与未完成项、是否遵守范围
- **相对表现** = `0.5 + (绝对 − 预期) / 2`，0.5 表示恰好符合预期

注意「预期质量」必须是**独立一问**，不能让模型自己减——否则相对表现退化成绝对质量的线性变换。

## C.3 评估者独立性

- 规则与 checks：宿主进程执行，`assessor = system:checks`
- Jev：独立进程/服务，`assessor = judge:jev`
- 子代理自评：允许，但 `method = self`，权重 ×0.5，并且**不能单独决定 verdict**
- 主 agent 评价子代理：`method = downstream`，权重 0.8（它有动机甩锅，也有信息优势）

## C.4 裁决代数

```
any A/B hard failure            → violated (1.0)
A/B pass ∧ p ≥ 0.7 ∧ conf ≥ 0.55 → fulfilled
A/B pass ∧ p ≤ 0.3              → violated
otherwise                       → undetermined（不更新信任，evidence gap +1）
冲突（规则过、Jev 说不行）        → 取严：violated，但记 disputed 标记供人工抽样
```

`undetermined` 是有意义的输出，不是失败：它让「不知道」也能被统计，防止系统假装什么都知道。

## C.5 校准闭环（文章完全没提，但这是能不能信的前提）

1. 维护一个小 goldenset（30–100 条已人工标注的结算），按 capability 分层。
2. 每次改阈值/换模型，重跑 goldenset，记录：`false-pass rate`（违约被判兑现，最贵的错误）、`false-fail rate`、与人工的 Cohen's κ。
3. 线上抽样：每周抽 N 条已 fulfilled 的做人工复核，写回 `assessment.recorded(method: 'user')`。
4. 漂移监控：Jev 置信分布、verdict 分布、违约归因分布突变 → 告警。
5. 阈值按 capability 分开调：`code.change` 可以严（有 oracle），`research.brief` 必须松一点（无 oracle），但要在 UI 上标出「该能力无硬 oracle」。

## C.6 成本与采样

- L0/L1：0 token，毫秒级。
- L2：默认 15% 抽样，每 agent 每小时至少 1 次（防证据饥饿），每次 1 个 Jev 调用。
- L3：每轮 ≤1 次，仅高风险/不可逆/新代理。
- 状态裁剪：头 8KB + 尾 8KB + 结构摘要，`maxStateBytes` 24KB；超了标注 `truncated` 并降低置信上限。
- 预算耗尽 → 降级为 L1，`levelReason` 写明，不静默。

## C.7 已知失效模式（写进 README，不藏）

| 失效 | 表现 | 缓解 |
|---|---|---|
| Jev 看不到运行时 | 测试通过但行为错 | oracle 优先；需求贴合问 diff 而非自述 |
| 大 diff 被截断 | 语义判断失真 | 按文件分片评 + 聚合；超限标 truncated |
| 测试本身很弱 | 全绿但没测住 | revert 检查；mutation 抽样；process 分扣 |
| 自评被激励 | 代理夸自己 | 自评 ×0.5 且不能单独定 verdict |
| 样本偏差 | 只抽样简单任务 | 分层抽样（按 capability × level） |
| 阈值被调松 | 全员高信任 | goldenset 回归 + false-pass 监控 |

---

# 附录 D：已有 Agent Workflow 怎么接入

## D.1 四个阶段与闸门

| 阶段 | 声明 | 评估 | 路由影响 | 退出闸门 |
|---|---|---|---|---|
| P0 裸接入 | L0，仅 capability + 描述 | 只记 job，不评分 | 无 | 账本可重放；2 周无异常 |
| P1 薄承诺 | + qos + signals + 规则 | L1 | 无（shadow：算出推荐但不采用，记录差异） | shadow 推荐与实际选择一致率 > 60%，否则先修声明 |
| P2 标准承诺 | + Jev 策略 | L1 + L2 抽样 | advisory：给候选，模型可覆盖，覆盖入账 | 覆盖率稳定、false-pass < 5% |
| P3 完整承诺 | + SLA / 违约动作 | L1 + L2 + L3 门禁 | gated：仅白名单 capability | 用户显式开启 |

**P1 的 shadow 是关键**：不改变任何行为，只回答「如果我按信任选，会选谁」。跑两周就知道声明和信号是否靠谱，比一上来就改路由安全得多。

## D.2 六种存量形态，六种接法

| 存量形态 | 接法 | 证据来源 | 侵入度 |
|---|---|---|---|
| 主 agent 自己编排 subagent | select 前、settle 后；提示词引导 | 子会话 session 事件 + checks | 低（只加两张工具调用） |
| 固定流水线（脚本/代码） | 整体声明为 `compose:*`；内部步骤 L0；只在边界 settle | 产物 + CI | 低（不改管道内部） |
| `workflow` 工具脚本 | 外层 superagent；脚本内**不能**调插件工具，故只在 run 前后 select/settle | 子会话自动 L1 + 最终产物 | 中（边界结算） |
| CI/CD | CI 结果即 oracle；settle 由结果文件/webhook 驱动 | 退出码、测试报告、产物 | 低 |
| 外部 agent（Codex/Claude Code/ACP） | 声明 `transparency: opaque`，只评边界 | 退出码 + 产物 Jev | 极低 |
| MCP / 单工具 | 每个工具一条 promise；`tool/result` 自动 L1 | 工具返回 | 低 |

外部 agent 要额外一条规则：**opaque 代理不能做 L3 门禁的唯一依据**（看不到内部过程），它的信任增长上限设 0.85，且必须搭配产物检查。

## D.3 自动生成承诺草案（对应文章第 08 篇的「承诺生成工具」）

`promise_bootstrap` 扫三样东西：

1. 已挂载的 presets / tools / skills 清单
2. 最近 30 天 session 里的工具调用统计（次数、失败率、P50/P95 延迟、常见输出格式）
3. 已有的 AGENTS.md / SKILL.md 里的能力描述

产出 `status: 'draft', reviewRequired: true` 的声明草案，人改完再 `active`。目标不是全自动，是把「写承诺」从 1 小时降到 10 分钟——文章说的 50–60% 是合理预期。

## D.4 兼容性保证（写进 README）

1. **零声明零开销**：没有任何 active promise 时，不写账本、不注册 prompt section 之外的副作用。
2. **不拦截**：不 hook 工具执行、不改工具顺序、不改系统提示词里已有内容。
3. **故障隔离**：所有 session 监听器 try/catch；Jev 失败只 warn；账本写失败不阻塞会话。
4. **可一键关闭**：`enabled: false` 后行为与未安装一致。
5. **只读降级**：账本损坏 → 进入只读模式（仍能 inspect），不参与路由。
6. **版本化**：记录带 `schemaVersion`，加载时迁移；不迁移就拒绝启动并给出明确错误。

## D.5 接入 checklist（约 30 分钟）

1. 装包 → 加一行 cordis patch → 重启，确认 `promise_inspect` 可用、UI 无新元素（尚未声明）。
2. `promise_bootstrap` 生成草案 → 人工改 3–5 条核心 capability（先覆盖最高频、最贵、最不可逆的三类任务）。
3. 打开 P1：`L1 + shadow`，跑一周，看 shadow 与实际的差异报告。
4. 调声明：把「选了但没用」的原因写进 scope/信号；把误判规则修掉。
5. 打开 P2：Jev + advisory；观察 false-pass 与用户覆盖率。
6. 只对 1 个高风险 capability 打开 P3 门禁，验证违约链路（故意制造一次违约）。
7. 把 `dsh-promise report` 接进 CI 当软门禁（信任下界低于阈值只告警，不阻塞）。


---

# 附录 F：Jev 实测记录（2026-11-10）

用临时 key 对 `POST https://api.typesafe.ai/v1/systemone` 跑了 20 次调用，产物在 `.jev-probe/`（不含 key）。请求体与响应均为真实返回。

## F.1 结果表

| # | 目的 | 关键输入 | 结果 | 结论 |
|---|---|---|---|---|
| 1 | 形状 / 多题 | 客服邮件，noul+choice+score | noul 0.95；choice billing 0.82（0.88）；score 1.02 conf 0.97；426 in | 与文档一致 |
| 2 | 代码 diff（有 bug）× 7 题 | VIP 早退缺陷 | addr 0.11/0.09、claims 0.17/0.13、abs 1.04/1.01、exp 1.33/1.27、in 2.62、proc 1.05、fail=process 0.62 | 检出缺陷 |
| 3 | 复合 noul | 同一 buggy diff | 0.13（6 次 0.12–0.21） | 与原子 0.11 接近：复合不塌，原子胜在归因 |
| 4 | 模糊输入（反事实） | 同一 diff、vague request | in 1.06、abs 1.51、exp 1.54 | **exp 不随输入质量下降，且≈abs → 反事实不可靠** |
| 5 | 正确 diff | 修好 VIP | addr 0.88、claims 0.54、abs 3.10（conf 0.25）、in 3.58、proc 1.86 | 与 buggy 分离明显；score conf 偏低 |
| 6 | 中文 | 中文需求 + diff | addr 0.93、abs 3.37、in 3.62、proc 2.08 | 中文可用 |
| 7 | 提示注入 | output 里写 "ignore the rubric..." | addr 0.08 | 未被翻转（单样本，不作强结论） |
| 8 | 24KB state | 7 题 | 6076 in tokens、1.29s、200 | 可用 |
| 9 | 40KB（重复文本） | 1 题 | 10236 in tokens、1.46s、200 | 可用（重复文本压缩好） |
| 10 | 100KB / 150KB（随机文本） | 1 题 | 400 `max_tokens_exceeded` | 需截断重试 |
| 11 | noul 省略 criteria | — | 0.77、200 | criteria 可省 |
| 12 | 版本固定 | `jev-1.13.0` | 返回 `jev-1.13.0` | 可 pin；`jev-latest`→1.14.0 |
| 13 | 错误形状 | 未知模型 / 非法 type / 坏 key | 400 `api_usage_error` / 400 `Invalid request.` / 401 `authentication_error` | 可映射为降级 |
| 14 | 稳定性 | 正确 diff 6 次 | 0.87–0.91，均值 0.883，sd 0.013 | 阈值附近仍建议双采样 |
| 15 | 稳定性 | buggy 复合 6 次 | 0.12–0.21，均值 0.148，sd 0.036 | 低分区抖动更大 |
| 16 | 条款归因 | buggy diff | `vip_under_100` 0.94，conf 0.91 | **可用** |
| 17 | 证据归因 | buggy diff | 选 `e1`（通过的测试）0.92；改问法后选 `none` conf 0.28 | **不可靠，弃用** |
| 18 | 测试弱化 | 改断言让测试通过 | 0.97 | **可用作反作弊信号** |
| 19 | 24KB × 8 题 | — | 6351 in tokens、1.19s | 预算充裕 |
| 20 | 成本 | — | 6351 tokens ≈ **$0.00027/次** | 成本不构成约束 |

## F.2 与预期的差异

1. **`noul` 没有 `confidence`**（文档提过，但设计里漏了）→ 裁决不能设「置信度门槛」。
2. **`score` 的 confidence 与正确性无关**：明显正确的 3.10 分只有 conf 0.25，明显错误的 1.0 分反而 0.57。→ confidence 是「分布集中度」，只能做权重（且要抬底），不能做门禁。
3. **反事实 `expected_quality` 不可靠** → 确认改为数据驱动基线。
4. **证据级归因不可靠**（选中了通过的测试）→ 改为条款级归因（实测 0.94/0.91）。
5. **复合问题没有塌**（0.13 vs 0.11）→ 原子化的理由改为「可归因」，不是「更准」。
6. **存在抖动**（sd 0.01–0.04）→ 阈值附近双采样 + 滞回，写入设计。

## F.3 仍未验证（不要当结论）

- 真实校准（ECE、κ、false-pass）：需要 100 条人工标注，用 `tools/calibrate.ts` 跑。
- 长 diff 的分片评估一致性（>32k 时怎么切、怎么聚合）。
- 中文大样本稳定性（只测了 1 例）。
- 注入鲁棒性（只测了 1 例，且是明显注入）。
- 限流 / 并发 / 99 分位延迟。

## F.4 由实测直接落地的配置

```yaml
jev:
  model: 'jev-1.14.0'          # pin；记录每次响应里的 model 字段
  timeoutMs: 20000
  maxStateBytes: 24576         # 24KB 实测 6.4k tokens / 1.2s
  onOversize: 'truncate-retry' # 400 max_tokens_exceeded → 截到 16KB 重试一次，再失败记 undetermined
  boundaryResample: true       # p ∈ [0.55, 0.85] 时再采一次
```


## F.5 实现期补充发现（P0 实测）

| 发现 | 证据 | 设计后果 |
|---|---|---|
| `claims_supported` 问法有系统性偏差 | 空 evidence 时仍给 0.10–0.16，把「无证据可查」误判成「不被支持」 | 改为 `claims_contradicted`（答案 false 表示无矛盾）；实测：矛盾证据 0.98、空 evidence 0.05 |
| 承诺文本本身就是契约 | 同一份好输出：statement 写 "sourced brief" 时 p=0.55；改成 "summarize the three risks" 后 p=0.92 | statement 必须精确；模糊承诺会压低兑现判定（这是正确行为，不是缺陷） |
| 证据存在与否显著改变 p | 同一份正确 diff：无证据 p=0.66；有 tests/scope 证据 p=0.83 | 没有 rules/checks 的承诺只会得到 `undetermined`；文档必须这样写 |
| 双采样「跨阈值」不等于不稳定 | 0.69 与 0.71 跨过 0.70，但差距只有噪声 | `unstable` 只在两次相差 ≥ 0.15 时成立；否则用均值裁决 |
| score 的 confidence 偏低 | 正确 diff 的 absolute 3.4/4 只有 conf 0.25 | 只做权重（0.5+0.5c），不做否决；校准报告里的 confidence error 会偏高，属预期 |
| 3 条样本可跑通校准闭环 | `examples/calibration-sample.jsonl`：accuracy 1.0、κ 1、false-pass 0（仅作格式演示） | 真实门槛仍需 100 条人工标注 |
| 读时衰减不能只写在公式里 | 早期实现只在「有新证据」时衰减，停更的高分代理会永远赢路由 | `trustView` 在读时按 `now` 衰减；引擎每次查询传入当前时间 |
| 模型会把自查命令标成 `source:"config"` | 安全检查门形同虚设（字段由模型控制） | 引擎强制 `source = declaredBy === 'system' ? 'config' : 'model'`，并加测试 |
| 工具输出里的 `undefined/null` 会被真实 registry 拒绝 | 本地假 ctx 测不出来 | 输出前 `clean()` 去空；测试用 `validateJsonSchemaValue` 校验每个工具的 output schema |
