import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnswer } from '../src/core/normalize.js';

const INT = { normalize_as: 'integer', answer_space: 'integer 1-100' };
const INT10 = { normalize_as: 'integer', answer_space: 'integer 1-10' };
const COIN_EN = { normalize_as: 'binary', answer_space: 'heads|tails' };
const WORD = { normalize_as: 'word', answer_space: 'any single word' };
const GRAPH = { normalize_as: 'grapheme', answer_space: 'one letter' };

test('integer answers', () => {
  assert.deepEqual(normalizeAnswer('42', INT, 'en'), { normalized: '42', answerClass: 'valid' });
  assert.deepEqual(normalizeAnswer('The number 7.', INT, 'en').normalized, '7');
  // out of range -> normalized kept but class invalid (faithful to upstream)
  const r = normalizeAnswer('742', INT10, 'en');
  assert.equal(r.normalized, '742');
  assert.equal(r.answerClass, 'invalid');
});

test('chinese numerals', () => {
  assert.equal(normalizeAnswer('七', INT, 'zh').normalized, '7');
  assert.equal(normalizeAnswer('十七', INT, 'zh').normalized, '17');
  assert.equal(normalizeAnswer('四十二', INT, 'zh').normalized, '42');
  assert.equal(normalizeAnswer('十', INT10, 'zh').answerClass, 'valid');
});

test('arabic-indic digits', () => {
  assert.equal(normalizeAnswer('٢٣', INT, 'ar').normalized, '23');
  assert.equal(normalizeAnswer('٧', INT10, 'ar').answerClass, 'valid');
});

test('coin flip canonicalization', () => {
  assert.equal(normalizeAnswer('Heads', COIN_EN, 'en').normalized, 'h');
  assert.equal(normalizeAnswer('"tails"', COIN_EN, 'en').normalized, 't');
  assert.equal(normalizeAnswer('正面', COIN_EN, 'zh').normalized, 'h');
  assert.equal(normalizeAnswer('решка', COIN_EN, 'ru').normalized, 't');
  assert.equal(normalizeAnswer('صورة', COIN_EN, 'ar').normalized, 'h');
  assert.equal(normalizeAnswer('banana', COIN_EN, 'en').answerClass, 'invalid');
});

test('refusals and empties', () => {
  assert.equal(normalizeAnswer("I can't do that", WORD, 'en').answerClass, 'refusal');
  assert.equal(normalizeAnswer('抱歉，无法回答', WORD, 'zh').answerClass, 'refusal');
  assert.equal(normalizeAnswer('', WORD, 'en').answerClass, 'empty');
  assert.equal(normalizeAnswer(null, WORD, 'en').answerClass, 'empty');
});

test('grapheme / letter tasks', () => {
  assert.equal(normalizeAnswer('b', GRAPH, 'en').normalized, 'b');
  assert.equal(normalizeAnswer('Letter B', GRAPH, 'en').normalized, 'b'); // single-char token fallback
  assert.equal(normalizeAnswer('书', GRAPH, 'zh').normalized, '书'); // zh multi-char allowed
});

test('word tasks', () => {
  assert.equal(normalizeAnswer('Apple', WORD, 'en').normalized, 'apple');
  assert.equal(
    normalizeAnswer('blue sky mountains rivers', WORD, 'en').answerClass,
    'invalid'
  ); // whole sentence => off-format
});
