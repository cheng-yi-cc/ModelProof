# ModelProof — 中转站模型身份辨认 / 注水检测

检测 API 中转站（代理商）是否在用其它模型冒充你所购买的模型。

输入中转站地址和 API Key，应用会向端点发送约 100–1000 次廉价的「单 token」探测请求
（如"随便说一个 1–100 的数字"、"抛硬币"），构建该端点的**行为指纹**，与论文实测的
165 个参考模型比对，判定它到底像不像声称的那个型号。

方法来源：Bruckner, *One Token Is Enough* (arXiv:2607.10252, 2026)。
完整许可与引用见 [ATTRIBUTION.md](ATTRIBUTION.md)。

## 下载与安装

直接前往 [Releases](https://github.com/cheng-yi-cc/ModelProof/releases) 页面下载对应系统的安装包：
- **Windows**: `ModelProof-x.x.x-Setup-x64.exe`（安装版）或 `ModelProof-x.x.x-Portable-x64.exe`（便携版）
- **macOS**: `ModelProof-x.x.x-mac-arm64.dmg`（Apple Silicon）或 `ModelProof-x.x.x-mac-x64.dmg`（Intel）
- **Linux**: `ModelProof-x.x.x-linux-x64.AppImage` 或 `.deb`

## 本地运行与打包

### 开发运行

```powershell
npm install     # 已配置国内镜像加速
npm start       # 启动桌面开发版
```

### 本地打包

```powershell
npm run dist:win    # 打包 Windows 安装包与便携版
npm run dist:mac    # 打包 macOS DMG 与 Zip（需在 macOS 环境）
npm run dist:linux  # 打包 Linux AppImage 与 deb（需在 Linux 环境）
```

使用步骤：

1. 「检测」页填入 API 地址（含或不含 `/v1` 均可）和 API Key → 点「连接并获取模型列表」；
2. 勾选要检测的模型（可全选批量排队）；
3. 选探测档位（快速 / 标准 / 严格 / 自定义）→ 点「开始检测」；
4. 到「报告」页查看每个模型的判定、最像模型排行、维度明细；可导出 HTML/JSON 报告。

判定标准（平均 Jensen-Shannon 散度，base-2）：

| 平均 JSD | 结论 |
|---|---|
| ≤ 0.25 | 与声称型号相符 |
| 0.25–0.35 | 存疑（可能是换上游部署/量化，也可能是轻量替换） |
| > 0.35 | 高概率不符 |

## 无风险自测（mock 中转站）

```powershell
# 模拟一个"假称 gpt-4o-mini、实际按 GLM-4.5-Air 分布应答"的中转站：
npm run mock -- --claim openai/gpt-4o-mini --serve z-ai/glm-4.5-air --port 8377
```

然后在应用里连接 `http://127.0.0.1:8378`（端口以命令输出为准），Key 随便填，
检测 `openai/gpt-4o-mini`，应当得到「高概率注水」且榜首是 GLM 系模型。
加 `--honest <模型ID>` 则模拟诚实端点，应判「相符」。

## 测试

```powershell
npm test                 # 单元 + mock 端到端（21 个用例）
node scripts/ui-smoke.mjs # 启动真实窗口做 UI 全流程冒烟测试
```

## 项目结构

```
src/core/        方法论引擎（协议/归一化/JSD/客户端/审计/分析），零第三方依赖
src/main/        Electron 主进程 + preload(CJS)
src/renderer/    中文界面
assets/          生成的参考指纹库（165 模型 × Study-A 40 维度）+ 距离背景
vendor/pamela/   论文数据与 prompt 原件（CC-BY-4.0 / MIT）
scripts/         参考库生成、mock 中转站、UI 冒烟测试
tests/           单元测试 + mock 端到端测试
```

## 局限

这是行为学证据而非密码学证明。端点注入系统提示词、推理模型的隐藏思维链、服务端缓存、
参考库未覆盖的小众模型都会干扰结论——应用会对这些信号给出提示徽章，请结合判断。
