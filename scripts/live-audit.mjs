// CLI audit entry — same engine as the desktop app, for scripting/batch use.
//
//   $env:RELAY_KEY="sk-..."; node scripts/live-audit.mjs <baseUrl> <model> [reps] [langsCsv]
//
// Prints the verdict and saves the raw fingerprint next to the report so you can
// re-analyze later without spending queries again.
import { AuditRunner } from '../src/core/audit.js';
import { analyze } from '../src/core/analyze.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const refDb = JSON.parse(readFileSync(path.join(ROOT, 'assets', 'reference-fingerprints.json'), 'utf8'));
const context = JSON.parse(readFileSync(path.join(ROOT, 'assets', 'distance-context.json'), 'utf8'));

const [baseUrl, model, repsArg, langsArg] = process.argv.slice(2);
if (!baseUrl || !model || !process.env.RELAY_KEY) {
  console.error('用法: $env:RELAY_KEY="sk-..."; node scripts/live-audit.mjs <baseUrl> <model> [reps=10] [langs=en,zh] [--allow-reasoning]');
  process.exit(1);
}
const allowReasoning = process.argv.includes('--allow-reasoning');
const reps = Math.max(5, Math.min(40, parseInt(repsArg ?? '10', 10)));
const langs = (langsArg ?? 'en,zh').split(',').filter((l) => ['en', 'ru', 'zh', 'ar'].includes(l));

console.log(`=== 审计 ${model} | ${baseUrl} | 每维度 ${reps} 次 × [${langs.join(',')}]${allowReasoning ? ' | 允许隐藏思维链' : ''} ===`);
const runner = new AuditRunner({ baseUrl, apiKey: process.env.RELAY_KEY, model, reps, langs, concurrency: 6, reasoningPolicy: allowReasoning ? 'allow' : 'strict' });
runner.opts.onEvent = (e) => {
  if (e.type === 'progress' && e.done % 25 === 0) console.log(`  进度 ${e.done}/${e.total} 失败${e.failed}`);
};
const t0 = Date.now();
const result = await runner.run();
console.log(`完成 ${result.progress.ok}/${result.progress.total}，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);

if (result.progress.ok === 0) {
  console.log('全部请求失败。错误样本:', result.diagnostics.errorSamples);
  process.exit(1);
}

const analysis = analyze({ fingerprint: result.fingerprint, refDb, context, claimedModel: model });
console.log('\n判定:', analysis.verdict.level, '|', analysis.verdict.label);
console.log(analysis.verdict.detail);
console.log('数据质量:', JSON.stringify(analysis.dataQuality));
if (analysis.distanceToClaimed != null) {
  const pct = analysis.percentileOfClaimed != null ? `，近于 ${(analysis.percentileOfClaimed * 100).toFixed(1)}% 的不同模型对` : '';
  console.log(`与声称型号平均 JSD: ${analysis.distanceToClaimed.toFixed(4)}${pct}`);
}
console.log('\nTop5 最像模型:');
for (const [i, t] of analysis.top.slice(0, 5).entries()) {
  console.log(`  ${i + 1}. ${t.model}  JSD=${t.jsd.toFixed(4)}  (${t.usableCells}维)`);
}
console.log('\n诊断:', JSON.stringify(result.diagnostics));

const out = path.join(ROOT, 'reports', `${model.replace(/[^\w.-]+/g, '_')}.json`);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({ model, baseUrl, reps, langs, when: new Date().toISOString(), analysis, diagnostics: result.diagnostics, fingerprint: result.fingerprint }, null, 1)
);
console.log(`\n完整结果已保存: ${out}`);
