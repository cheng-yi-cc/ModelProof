# Attribution & Licenses

ModelProbe 的方法论、探测协议与参考指纹库来自以下研究产物：

## 论文
- Tomáš Bruckner. *One Token Is Enough: Fingerprinting and Verifying Large Language
  Models from Single-Token Output Distributions.* arXiv:2607.10252, 2026.
  https://arxiv.org/abs/2607.10252

## 数据（参考指纹库来源）
- Tomáš Bruckner. *Single-token output distributions as behavioral fingerprints of
  large language models.* Zenodo, 2026. doi:10.5281/zenodo.21278557
  **License: CC-BY-4.0**

  `assets/reference-fingerprints.json` 与 `assets/distance-context.json`
  由 `scripts/build-reference.mjs` 从该数据集生成（仅提取 Study-A 任务、温度=1、
  n_valid≥10 的 cell），随应用分发时须保留本声明。

## 软件（协议复刻来源）
- Tomáš Bruckner. *PAMELA — full software for data collection and study A analysis.*
  Zenodo, 2026. doi:10.5281/zenodo.21278793 **License: MIT**

  `vendor/pamela/prompts.json` 为逐字节一致的副本（SHA-256
  `32f4fc3ab5077438f362bb4d0c06d1ebbe2bb5d2e0809474045dcd60a6b592c1`，
  运行时自动校验）；`src/core/normalize.js` 忠实移植其归一化逻辑；
  `src/core/jsd.js` 使用同一散度定义。

## 本项目
- ModelProof 应用代码：MIT。
