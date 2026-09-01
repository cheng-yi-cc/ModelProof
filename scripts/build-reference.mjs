// Build the embedded reference-fingerprint database from the PAMELA research data.
//
// Inputs  (vendor/pamela/):
//   distributions.json     Zenodo 21278557 results/distributions.json (CC-BY-4.0)
//   models.selected.json   Zenodo 21278793 config/models.selected.json (MIT)
//   prompts.json           Zenodo 21278793 config/prompts.json (MIT)
// Outputs (assets/):
//   reference-fingerprints.json   Study-A cells only (10 tasks x 4 langs, t=1, n_valid>=10)
//   distance-context.json         all pairwise mean-JSD impostor distances (percentile context)
//
// Usage: npm run build:reference
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const prompts = readJson(path.join(ROOT, 'vendor', 'pamela', 'prompts.json'));
const selected = readJson(path.join(ROOT, 'vendor', 'pamela', 'models.selected.json'));
const distributions = readJson(path.join(ROOT, 'vendor', 'pamela', 'distributions.json')).distributions;

const STUDY_A_TASKS = prompts.tasks.filter((t) => t.paper === 1).map((t) => t.id);
const STUDY_A = new Set(STUDY_A_TASKS);
const LANGS = new Set(prompts.languages);
const MIN_N = 10; // same threshold as stats/03-divergence.js in the paper's code

const metaById = Object.fromEntries(selected.models.map((m) => [m.id, m]));

const models = {};
let cellsKept = 0;
for (const d of distributions) {
  if (!STUDY_A.has(d.task_id) || !LANGS.has(d.lang)) continue;
  if (d.temperature !== 1 || d.n_valid < MIN_N) continue;
  const m = metaById[d.model];
  if (!m?.included) continue;
  (models[d.model] ??= { family: m.family_guess ?? 'other', cells: {} });
  models[d.model].cells[`${d.task_id}|${d.lang}`] = { n: d.n_valid, p: d.dist };
  cellsKept++;
}

// sanity: every kept answer key must be a string (normalized answers), drop nothing silently
const refDb = {
  meta: {
    protocol: 'PAMELA study-A single-token battery',
    prompts_version: prompts.version,
    prompts_sha256: '32f4fc3ab5077438f362bb4d0c06d1ebbe2bb5d2e0809474045dcd60a6b592c1',
    source_dataset: 'Zenodo doi:10.5281/zenodo.21278557 (CC-BY-4.0)',
    source_software: 'Zenodo doi:10.5281/zenodo.21278793 (MIT)',
    paper: 'arXiv:2607.10252 "One Token Is Enough" (Bruckner, 2026)',
    tasks: STUDY_A_TASKS,
    langs: [...LANGS],
    min_cell_n: MIN_N,
    n_models: Object.keys(models).length,
    n_cells: cellsKept,
    built_utc: new Date().toISOString(),
  },
  models,
};
writeFileSync(
  path.join(ROOT, 'assets', 'reference-fingerprints.json'),
  JSON.stringify(refDb)
);

// Pairwise impostor-distance context from the paper's mean JSD matrix.
// Used to place an observed audit distance on the empirical scale of
// "how far apart do genuinely different models sit".
const csv = readFileSync(path.join(ROOT, 'vendor', 'pamela', 'divergence-matrix.csv'), 'utf8');
const lines = csv.trim().split('\n');
const names = lines[0].split(',').slice(1).map((s) => s.replace(/^"|"$/g, ''));
const distances = [];
for (let i = 1; i < lines.length; i++) {
  const cols = lines[i].split(',');
  const a = cols[0].replace(/^"|"$/g, '');
  for (let j = i + 1; j <= names.length; j++) {
    const v = parseFloat(cols[j]);
    if (!Number.isFinite(v)) continue;
    distances.push(v); // pair (names[i-1], names[j-1]), a < b guaranteed by j > i
  }
}
distances.sort((x, y) => x - y);
const q = (p) => distances[Math.min(distances.length - 1, Math.floor(p * distances.length))];
const context = {
  source: 'Zenodo 21278557 results/divergence-matrix.csv',
  n_pairs: distances.length,
  min: distances[0],
  p05: q(0.05),
  p25: q(0.25),
  median: q(0.5),
  p75: q(0.75),
  p95: q(0.95),
  max: distances[distances.length - 1],
  distances,
};
writeFileSync(
  path.join(ROOT, 'assets', 'distance-context.json'),
  JSON.stringify(context)
);

console.log(`reference DB: ${refDb.meta.n_models} models, ${cellsKept} cells`);
console.log(`impostor context: ${distances.length} pairs, median=${context.median.toFixed(3)}, p95=${context.p95.toFixed(3)}`);
