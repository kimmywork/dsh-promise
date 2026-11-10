import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregate, applyEvidence, effectiveN, recordKey, trustView, wilsonLower } from '../src/trust.js'

const opts = { prior: 0.5, halfLifeDays: 14 }

test('new trust record starts at the prior with zero evidence', () => {
  const view = trustView(new Map(), 'preset:a', 'code.change')
  assert.equal(view.score, 0.5)
  assert.equal(view.mass, 0)
  assert.equal(view.lower, 0.5)
  assert.equal(view.count, 0)
})

test('one observation is shrunk toward the prior', () => {
  const at = Date.now()
  const record = applyEvidence(undefined, { score: 1, weight: 0.7, at }, opts)
  const expected = (0.5 * 1 + 1 * 0.7) / 1.7
  assert.ok(Math.abs(record.score - expected) < 1e-9)
  assert.ok(record.score < 1)
})

test('decay reverts the score toward the prior and halves mass', () => {
  const at = Date.now()
  const first = applyEvidence(undefined, { score: 1, weight: 5, at }, opts)
  const later = applyEvidence(first, { score: 1, weight: 0.0001, at: at + 14 * 86_400_000 }, opts)
  assert.ok(later.score < first.score)
  assert.ok(later.score > 0.5)
})

test('aggregate is a mass-weighted mean across assessors', () => {
  const combined = aggregate([
    { score: 0.9, mass: 3, count: 4 },
    { score: 0.3, mass: 1, count: 1 },
  ])
  assert.ok(Math.abs(combined.score - (0.9 * 3 + 0.3) / 4) < 1e-9)
  assert.equal(combined.count, 5)
})

test('wilson lower bound is conservative and monotonic in evidence', () => {
  assert.equal(wilsonLower(0.9, 0), 0.5)
  const few = wilsonLower(0.8, 2)
  const many = wilsonLower(0.8, 40)
  assert.ok(few < many)
  assert.ok(many < 0.8)
})

test('effectiveN converts mass into pseudo samples', () => {
  assert.equal(effectiveN(0.7), 1)
  assert.equal(effectiveN(0), 0)
})

test('trustView separates assessors and aggregates them', () => {
  const at = Date.now()
  const map = new Map()
  const judge = applyEvidence(undefined, { score: 1, weight: 2, at }, opts)
  const user = applyEvidence(undefined, { score: 0.2, weight: 1, at }, opts)
  map.set(recordKey('preset:a', 'code.change', 'judge:jev'), judge)
  map.set(recordKey('preset:a', 'code.change', 'user:feedback'), user)
  const view = trustView(map, 'preset:a', 'code.change')
  assert.equal(view.assessors, 2)
  assert.ok(view.score > 0.5 && view.score < 0.9)
  assert.equal(trustView(map, 'preset:a', 'other.capability').count, 0)
})
