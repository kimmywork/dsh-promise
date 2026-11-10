# dsh-promise

> ⚠️ **试验性插件（experimental）**：这是 Promise Theory 在 DeepSeek Harness（DSH）上的一次实验性实现。**API、信任数学与 Jev 校准都不是生产稳定（production-stable）的**，可能随时变化；生产或高风险场景请自行评估、谨慎采用。

把「承诺（promise）—证据（evidence）—信任（trust）—结算（settlement）」落成 DSH 插件：代理在接受任务之前先声明可证伪的承诺，任务结束后由结构规则、可执行检查与类型化语义评估判定是否兑现，并把结果累积成按能力区分的信任。

它不接管工具调用，不做编排，也不自动重试——重试是编排决策，插件只提供备选与理由。

## 链接

| | |
|---|---|
| 背景文章（X） | <https://x.com/kenpusney/status/2119797864058769860> |
| 仓库 | <https://github.com/kimmywork/dsh-promise> |
| 包 README（使用 / 评估 / 配置 / 限制） | [`packages/dsh-promise/README.md`](packages/dsh-promise/README.md) |
| 安装快速开始 | [`packages/dsh-promise/install.sh`](packages/dsh-promise/install.sh) |
| 文档索引 | [`docs/README.md`](docs/README.md) |

## 它做什么

- **选之前**：按「有证据的信任」而不是名字或直觉，给出可解释的候选排序。
- **做之后**：用规则、可执行检查和类型化语义评估（[Jev](https://docs.typesafe.ai/introduction) 的 noul / choice / score）判定承诺是否兑现。
- **长期**：把每次判定累积成按 `agent × capability × assessor` 分离的信任，违约有代价、有恢复路径。

插件提供六个模型侧工具：`promise_declare` / `promise_select` / `promise_settle` / `promise_delegate` / `promise_inspect` / `promise_compose`。

## 安装（快速开始）

npm 包名是 `@unsafe/dsh-promise`（`experimental` dist-tag）；从本仓库 checkout 安装时用下面的 `install.sh`。

需要 Node ≥ 20.11，纯 ESM，无构建步骤。插件是 DSH bundle，安装本身需要你手动执行 `pnpm add`：

```bash
cd packages/dsh-promise
./install.sh                            # 打印安装步骤与 cordis.patch.yml 行，不改 profile
./install.sh --apply --profile desktop  # 只在目标 profile 里执行 pnpm add --force
npm test                                # 124 个离线测试，不触网
```

装完重启 DSH，在侧栏 **插件 → 已安装插件 → dsh-promise** 打开开关。没有 `TYPESAFE_API_KEY` 时插件退化为 L1（规则 + 可执行检查），不会失败。完整步骤、YAML 备选与 Jev 配置见[包 README](packages/dsh-promise/README.md#安装)。

## 文档索引

- [包 README](packages/dsh-promise/README.md) —— 安装、最短使用路径、评估、信任、配置、校准与已知限制。
- [接入点与触发点](packages/dsh-promise/docs/integration-points.md) —— Promise Theory 概念到实现的映射，以及自动绑定的触发点与「无感」程度。
- [Promise Agent 系列（归档）](docs/promise-agent.md) —— 关于 Promise Theory 与多代理系统的连载原文，仅供阅读参考。
- [docs/README.md](docs/README.md) —— 全部文档的索引。

## 边界与实验性

- **不是生产稳定版本**：API、信任数学（证据加权、时间衰减、Wilson 下界）与 Jev 校准都仍在实验阶段，行为可能变化。
- 语义证据在通过 `tools/calibrate.js` 校准（false-pass ≤ 5%、κ ≥ 0.6）前，只应作为提示，不应单独驱动信任。
- Jev 在某些地区会返回 `451 not available in your region`；没有可用代理时插件跳过语义层、只跑 L1。
- ds-bot 的会话关联目前不支持，`message_bot` 仍需手动结算。
- 账本是单进程写入的 JSONL，多进程并发写不在当前实验范围内。

最新说明以仓库为准：<https://github.com/kimmywork/dsh-promise>
