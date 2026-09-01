import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createMockRelay } from '../scripts/mock-relay.mjs';
import { AuditRunner } from '../src/core/audit.js';
import { analyze } from '../src/core/analyze.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const refDb = JSON.parse(readFileSync(path.join(ROOT, 'assets', 'reference-fingerprints.json'), 'utf8'));
const context = JSON.parse(readFileSync(path.join(ROOT, 'assets', 'distance-context.json'), 'utf8'));

test('protocol integrity: prompts hash verified on import', async () => {
  await import('../src/core/protocol.js'); // throws if vendor/pamela/prompts.json was tampered with
});

test('end-to-end: mock relay serving GLM while claiming GPT-4o-mini gets flagged', { timeout: 120000 }, async () => {
  const claimModel = 'openai/gpt-4o-mini';
  const serveModel = 'z-ai/glm-4.5-air';
  const mock = await createMockRelay({ claimModel, serveModel, latencyMs: 2 });

  try {
    // sanity: client can list models
    const { RelayClient } = await import('../src/core/client.js');
    const client = new RelayClient({ baseUrl: mock.url, apiKey: 'sk-test' });
    const listing = await client.listModels();
    assert.ok(listing.ok);
    assert.ok(listing.models.includes(claimModel));

    const runner = new AuditRunner({
      baseUrl: mock.url,
      apiKey: 'sk-test',
      model: claimModel,
      reps: 15,
      concurrency: 8,
      langs: ['en', 'zh'], // 20 cells x 15 = 300 requests, fast on localhost
      seed: 'e2e-test',
    });
    const result = await runner.run();
    assert.equal(result.progress.failed, 0);
    assert.equal(result.diagnostics.modelReportedMismatch, 0); // mock echoes the claim
    assert.ok(Object.keys(result.fingerprint).length >= 18);

    const out = analyze({
      fingerprint: result.fingerprint,
      refDb,
      context,
      claimedModel: claimModel,
    });
    assert.equal(out.verdict.level, 'mismatch');
    assert.ok(out.distanceToClaimed > 0.35, `distanceToClaimed=${out.distanceToClaimed}`);
    const servedRank = out.top.findIndex((t) => t.model === serveModel);
    assert.ok(servedRank > -1 && servedRank < 3, `served model rank in top list: ${servedRank}, top=${out.top[0]?.model}`);

    // honest mock: same endpoint claiming truthfully -> match verdict
    const honest = await createMockRelay({ claimModel: serveModel, serveModel, latencyMs: 2 });
    try {
      const r2 = new AuditRunner({
        baseUrl: honest.url, apiKey: 'sk-test', model: serveModel,
        reps: 15, concurrency: 8, langs: ['en', 'zh'], seed: 'e2e-honest',
      });
      const res2 = await r2.run();
      const out2 = analyze({ fingerprint: res2.fingerprint, refDb, context, claimedModel: serveModel });
      assert.equal(out2.verdict.level, 'match');
      assert.ok(out2.distanceToClaimed < 0.25);
    } finally {
      await honest.close();
    }
  } finally {
    await mock.close();
  }
});

test('end-to-end: streaming-only relay (Stream must be set to true) is handled transparently', { timeout: 120000 }, async () => {
  const model = 'mistralai/mistral-small-3.2-24b-instruct';
  if (!refDb.models[model]) return; // guard if reference set changes
  const mock = await createMockRelay({
    claimModel: model,
    serveModel: model,
    latencyMs: 2,
    requireStream: true,
  });
  try {
    const r = new AuditRunner({
      baseUrl: mock.url, apiKey: 'sk-test', model,
      reps: 12, concurrency: 8, langs: ['en'], seed: 'e2e-stream',
    });
    const res = await r.run();
    assert.equal(res.progress.failed, 0);
    assert.ok(Object.keys(res.fingerprint).length >= 9);

    const out = analyze({ fingerprint: res.fingerprint, refDb, context, claimedModel: model });
    assert.equal(out.verdict.level, 'match');
    assert.ok(out.distanceToClaimed < 0.25);
  } finally {
    await mock.close();
  }
});

test('hidden-reasoning responses: strict excludes them, allow keeps clean answers', { timeout: 120000 }, async () => {
  const model = 'mistralai/mistral-small-3.2-24b-instruct';
  if (!refDb.models[model]) return;
  const mock = await createMockRelay({ claimModel: model, serveModel: model, latencyMs: 2, emitReasoning: true });
  try {
    const common = { baseUrl: mock.url, apiKey: 'sk-test', model, reps: 12, concurrency: 8, langs: ['en'] };

    const strict = new AuditRunner({ ...common, seed: 'e2e-rs' });
    const strictRes = await strict.run();
    assert.equal(strictRes.diagnostics.reasoningTraces, strictRes.progress.ok);
    assert.equal(strictRes.diagnostics.answerClasses.post_reasoning, strictRes.progress.ok);
    const strictOut = analyze({ fingerprint: strictRes.fingerprint, refDb, context, claimedModel: model });
    assert.equal(strictOut.verdict.level, 'insufficient-data');

    const allow = new AuditRunner({ ...common, seed: 'e2e-ra', reasoningPolicy: 'allow' });
    const allowRes = await allow.run();
    assert.ok(allowRes.diagnostics.answerClasses.valid > 0);
    const allowOut = analyze({ fingerprint: allowRes.fingerprint, refDb, context, claimedModel: model });
    assert.equal(allowOut.verdict.level, 'match');
  } finally {
    await mock.close();
  }
});
