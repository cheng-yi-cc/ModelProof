# ModelProof 开发者与 Agent 规则手册

本文档为在本项目中进行开发、测试与维护的 AI Agent 及人类开发者提供核心约定与红线指引。

---

## 1. 项目概览与架构

ModelProof 是一款用于检测 API 中转站模型注水、货不对板的桌面与 CLI 工具。
核心理论基于 Bruckner, *One Token Is Enough* (arXiv:2607.10252, 2026) 提出的单 token 探测行为指纹学与 Jensen-Shannon 散度（JSD）比对。

### 目录分工
- `src/core/`：纯逻辑引擎（零第三方依赖），含协议校验（`protocol.js`）、答案归一化（`normalize.js`）、JSD 散度计算（`jsd.js`）、中转通信客户端（`client.js`）、指纹采集引擎（`collector.js`）、审计探针（`audit.js`）及比对判定（`analyze.js`）。
- `src/main/`：Electron 主进程与 preload 脚本。负责窗口生命周期、IPC 事件转发及用户本地指纹库持久化。
- `src/renderer/`：纯前端界面（HTML/CSS/JS，原生 ES Modules），负责交互展示。
- `assets/`：官方收录的标准参考指纹库（`reference-fingerprints.json`，已收录 182 个模型）及经验分布距离基准（`distance-context.json`）。
- `scripts/`：运维与自动化脚本（指纹批量采集 `collect-fingerprints.mjs`、Mock 中转站 `mock-relay.mjs`、参考库构建 `build-reference.mjs` 等）。
- `tests/`：单元测试与端到端测试。

---

## 2. 常用开发与测试命令

所有命令均支持跨平台执行：

```powershell
# 安装依赖（已配置国内镜像）
npm install

# 启动本地开发版（用于本地预览与交互测试）
npm start

# 执行自动化测试套件（23 个单元与端到端用例）
npm test

# 启动真实窗口做 UI 冒烟测试
node scripts/ui-smoke.mjs

# 启动 Mock 假称中转站做自测
npm run mock -- --claim openai/gpt-4o-mini --serve z-ai/glm-4.5-air --port 8377

# 采集指纹并合并至官方库（支持断点自动跳过与单模型即时持久化）
node scripts/collect-fingerprints.mjs --api-key "sk-..." --models "model-a,model-b" --merge
```

---

## 3. 核心红线与开发约定

### 零第三方依赖红线
- `src/core/` 下的代码**严禁引入任何第三方 npm 依赖**。必须仅使用 Node.js 原生 API 或纯 JavaScript。

### 指纹采集与探测规范
1. **单 Token 纯度保证**：探测请求必须严格限制 `max_tokens`（默认为 16，对于强制推理模型最低弹性提升至 64），温度严格保持 `temperature = 1`。
2. **思维链抑制**：对于 OpenRouter 等上游，必须使用 `"reasoning": { "effort": "none", "exclude": true }`。严禁随意放开思考产生大量 reasoning tokens，既违背论文无深思即时采样先验，又会造成严重额外费用。
3. **单模型即时持久化**：指纹采集脚本必须保持“跑完一个模型即时写盘并合并入库”机制，严禁将多模型全量暂存在内存中延迟保存。
4. **欠费立即熔断**：通信遇到 HTTP 402（`Insufficient credits` / `payment required`）必须视为不可重试的致命错误，立即中断并停止后续所有模型采样。

### 本地预览要求
- 当项目发生代码修改时，必须通过 `npm test` 保证测试全通，并告知用户通过 `npm start` 在本地启动应用验证界面与功能。

---

## 4. 判定尺度速查

平均 Jensen-Shannon 散度（base-2，取值范围 `[0, 1]`）：
- **JSD ≤ 0.25**：与声称型号相符；
- **0.25 < JSD ≤ 0.35**：存疑（常见于量化版本、不同服务商部署或轻量替换）；
- **JSD > 0.35**：高概率不符（注水/冒名顶替）。
