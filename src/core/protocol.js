// Protocol definition: loads the byte-exact PAMELA prompts.json (MIT) and
// verifies its SHA-256 against the hash recorded in the dataset manifests, so
// every probe we send is provably identical to what collected the reference data.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const EXPECTED_PROMPTS_SHA256 =
  '32f4fc3ab5077438f362bb4d0c06d1ebbe2bb5d2e0809474045dcd60a6b592c1';

const PROMPTS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'vendor',
  'pamela',
  'prompts.json'
);

const rawStr = readFileSync(PROMPTS_PATH, 'utf8').replace(/\r\n/g, '\n');
const fileBytes = Buffer.from(rawStr, 'utf8');
const actualSha = createHash('sha256').update(fileBytes).digest('hex');
if (actualSha !== EXPECTED_PROMPTS_SHA256) {
  throw new Error(`prompts.json integrity check failed: ${actualSha}`);
}

export const PROTOCOL = JSON.parse(rawStr);

// Study-A battery (paper 1): 10 tasks x 4 languages = 40 cells.
const STUDY_A_TASKS = PROTOCOL.tasks.filter((t) => t.paper === 1);
export const TASKS = STUDY_A_TASKS;
export const TASK_IDS = STUDY_A_TASKS.map((t) => t.id);
export const LANGS = PROTOCOL.languages; // en ru zh ar

export function systemPrompt(lang) {
  return PROTOCOL.system_prompts[lang];
}

export function taskById(id) {
  return PROTOCOL.tasks.find((t) => t.id === id);
}

export function buildCells({ langs = LANGS, taskIds = TASK_IDS } = {}) {
  const cells = [];
  for (const taskId of taskIds) {
    const task = taskById(taskId);
    if (!task || task.paper !== 1) continue;
    for (const lang of langs) cells.push({ taskId, lang });
  }
  return cells;
}
