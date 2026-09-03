#!/usr/bin/env node
// Automated model fingerprint collector strictly adhering to the PAMELA Study-A protocol.
// Paper: Bruckner, "One Token Is Enough" (arXiv:2607.10252, 2026).
//
// Thin CLI wrapper around the shared engine in src/core/collector.js — the
// GUI「采集指纹」页 uses the exact same engine, so CLI and app always agree.
//
// Usage:
//   node scripts/collect-fingerprints.mjs --api-key "sk-..." --models "openai/gpt-5.6-luna,openai/gpt-5.6-terra" --reps 30 --merge

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RelayClient } from '../src/core/client.js';
import { FingerprintCollector, inferFamily } from '../src/core/collector.js';
import { TASKS, LANGS } from '../src/core/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [],
    reps: 30,
    concurrency: 6,
    merge: false,
    force: false,
    out: path.join(ROOT, 'reports', 'collected-fingerprints.json'),
    family: null,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--api-key' && args[i + 1]) opts.apiKey = args[++i];
    else if (a === '--base-url' && args[i + 1]) opts.baseUrl = args[++i];
    else if (a === '--models' && args[i + 1]) {
      opts.models = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--reps' && args[i + 1]) opts.reps = parseInt(args[++i], 10) || 30;
    else if (a === '--concurrency' && args[i + 1]) opts.concurrency = parseInt(args[++i], 10) || 6;
    else if (a === '--out' && args[i + 1]) opts.out = path.resolve(args[++i]);
    else if (a === '--family' && args[i + 1]) opts.family = args[++i];
    else if (a === '--merge') opts.merge = true;
    else if (a === '--force') opts.force = true;
  }

  return opts;
}

async function main() {
  const opts = parseArgs();

  if (!opts.apiKey) {
    console.error('错误: 请提供 API Key (--api-key 或 OPENROUTER_API_KEY 环境变量)');
    process.exit(1);
  }
  if (!opts.models || opts.models.length === 0) {
    console.error('错误: 请指定要采集的模型 (--models "model-a,model-b")');
    process.exit(1);
  }

  const client = new RelayClient({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    timeoutMs: 45000,
  });

  console.log(`[Collector] 初始化 OpenRouter 客户端... BaseURL: ${opts.baseUrl}`);
  console.log(`[Collector] 待采集模型列表 (${opts.models.length} 个):`, opts.models);

  const refPath = path.join(ROOT, 'assets', 'reference-fingerprints.json');
  const collected = {};

  for (const modelId of opts.models) {
    // Check if model is already in reference database with sufficient cells
    if (!opts.force && existsSync(refPath)) {
      try {
        const existingDb = JSON.parse(readFileSync(refPath, 'utf8'));
        const existingModel = existingDb.models?.[modelId];
        if (existingModel && existingModel.cells) {
          const validCells = Object.keys(existingModel.cells).length;
          if (validCells >= 30) {
            console.log(`\n[Collector] 模型 ${modelId} 已在指纹库中且维度充足 (${validCells}/40)，自动跳过。`);
            continue;
          }
        }
      } catch {
        // ignore parse error, proceed
      }
    }

    const collector = new FingerprintCollector({
      client,
      modelId,
      reps: opts.reps,
      concurrency: opts.concurrency,
    });

    console.log(`\n======================================================`);
    console.log(`[Collector] 开始采集模型: ${modelId}`);
    console.log(`[Collector] 维度数: 40 | 每维采样数: ${opts.reps} | 计划总请求: ${40 * opts.reps}`);
    console.log(`======================================================`);

    const t0 = Date.now();
    let lastLine = '';
    const result = await collector.run((evt) => {
      const pct = ((evt.done / evt.total) * 100).toFixed(1);
      lastLine = `[进度] ${evt.done}/${evt.total} (${pct}%) | 有效 ${evt.valid} | 失败 ${evt.failed}`;
      process.stdout.write(`\r${lastLine}`);
    });

    if (result.quotaExceeded) {
      console.error(`\n======================================================`);
      console.error(`[Collector 额度中断] 检测到 API 账户欠费 / 余额不足 (HTTP 402)！`);
      console.error(`[Collector 详情] ${result.quotaError || 'Insufficient credits'}`);
      console.error(`[Collector 说明] 模型 ${modelId} 尚未完成，已立即熔断终止后续所有请求，保护账户不再产生无效调用。`);
      console.error(`======================================================`);
      break;
    }

    if (result.cancelled) {
      console.log(`\n[Collector] ${modelId} 已取消，跳过。`);
      continue;
    }

    const s = result.stats;
    const elapsedTotal = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`\r${' '.repeat(Math.max(lastLine.length, 20))}\r`);
    console.log(`[Collector] 模型 ${modelId} 采集完成: 耗时 ${elapsedTotal}s, 成功 ${s.ok}, 失败 ${s.failed}`);
    console.log(`[Collector] 统计: 有效答案总数 ${s.totalValid}, 充足维度数 ${s.sufficientCells}/40`);

    const modelEntry = {
      family: opts.family || inferFamily(modelId),
      cells: result.fingerprint,
      meta: {
        totalValid: s.totalValid,
        sufficientCells: s.sufficientCells,
        reps: opts.reps,
        concurrency: opts.concurrency,
        collected_at: new Date().toISOString(),
      },
    };
    collected[modelId] = modelEntry;

    // 1. 即时增量保存到 reports 文件
    const outDir = path.dirname(opts.out);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    let reportData = {};
    if (existsSync(opts.out)) {
      try { reportData = JSON.parse(readFileSync(opts.out, 'utf8')); } catch {}
    }
    reportData[modelId] = modelEntry;
    writeFileSync(opts.out, JSON.stringify(reportData, null, 2), 'utf8');
    console.log(`[Collector] 模型 ${modelId} 结果已即时存入: ${opts.out}`);

    // 2. 若启用 --merge，即时安全合并入官方指纹库（原子写入）
    if (opts.merge) {
      let refDb = {
        meta: {
          protocol: 'PAMELA study-A single-token battery',
          source_dataset: 'Zenodo doi:10.5281/zenodo.21278557 + OpenRouter Live Probes',
          tasks: TASKS.map((t) => t.id),
          langs: LANGS,
          min_cell_n: 10,
          n_models: 0,
          n_cells: 0,
          built_utc: new Date().toISOString(),
        },
        models: {},
      };

      if (existsSync(refPath)) {
        try { refDb = JSON.parse(readFileSync(refPath, 'utf8')); } catch {}
      }

      refDb.models[modelId] = {
        family: modelEntry.family,
        cells: modelEntry.cells,
      };

      let totalCells = 0;
      for (const m of Object.values(refDb.models)) {
        totalCells += Object.keys(m.cells || {}).length;
      }
      refDb.meta.n_models = Object.keys(refDb.models).length;
      refDb.meta.n_cells = totalCells;
      refDb.meta.last_updated_utc = new Date().toISOString();

      const tmpRef = `${refPath}.tmp`;
      writeFileSync(tmpRef, JSON.stringify(refDb, null, 2), 'utf8');
      renameSync(tmpRef, refPath);
      console.log(`[Collector] 模型 ${modelId} 已即时合并入指纹库: ${refPath}`);
      console.log(`[Collector] 当前指纹库包含模型总数: ${refDb.meta.n_models} 个 (总维度: ${refDb.meta.n_cells})`);
    }
  }

  if (!Object.keys(collected).length) {
    console.log('\n[Collector] 没有新采集的模型指纹（可能已全部在库中并跳过）。');
    return;
  }

  console.log(`\n======================================================`);
  console.log(`[Collector] 全部采集任务完成！本次共采集 ${Object.keys(collected).length} 个新模型。`);
  console.log(`======================================================`);
}

main()
  .catch((err) => {
    console.error('[Collector Fatal Error]', err);
    process.exitCode = 1;
  });
