# Promise Agent / dsh-promise

这个仓库有两部分：

1. **原文**：[`promise-agent.md`](promise-agent.md) —— 关于 Promise Theory 与多代理系统的 12 篇连载。
2. **实现**：[`packages/dsh-promise`](packages/dsh-promise/README.md) —— 把其中的「承诺—评估—信任」范式落成 DeepSeek Harness 插件。
3. **设计**：[`DESIGN.md`](DESIGN.md) —— 价值评估、架构、信任数学、评估阶梯、UI、存量接入、Jev 实测与校准方案。

## 快速开始

```bash
cd packages/dsh-promise
npm test                       # 97 个离线测试
./install.sh                   # 打印安装步骤与 cordis.patch.yml 行
```

插件提供五个工具：`promise_declare` / `promise_select` / `promise_settle` / `promise_inspect` / `promise_compose`。
评估分层：L1 规则与宿主执行的检查、L2 抽样语义评估、L3 完整评估；语义层用 [Jev](https://docs.typesafe.ai/introduction) 的类型化问答（noul / choice / score），不解析自由文本。

## 当前状态

- P0：插件、账本、信任引擎、五个工具、自动采集、校准脚本、文档、测试均已完成。
- 未接入 desktop profile：安装需你手动执行 `pnpm add` 并加一行 patch（见包内 README）。
- 语义证据在通过 `tools/calibrate.js` 校准（false-pass ≤ 5%、κ ≥ 0.6）前，只应作为提示，不应单独驱动信任。
