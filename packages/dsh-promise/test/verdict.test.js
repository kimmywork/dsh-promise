import test from 'node:test'
import assert from 'node:assert/strict'
import { compositeScore, decide, verdictScore } from '../src/verdict.js'

const thresholds = { pass: 0.7, claim: 0.6, fail: 0.3 }

test('a hard rule failure vetoes with full confidence', () => {
  const result = decide({
    rules: [{ id: 'tests', hard: true, ok: false }],
    semantic: { addressesRequest: 0.99, claimsContradicted: 0, confidence: 0.9 },
    thresholds,
  })
  assert.equal(result.verdict, 'violated')
  assert.equal(result.confidence, 1)
  assert.equal(result.failureMode, 'rule:tests')
})

test('soft rule failures do not veto', () => {
  const result = decide({
    rules: [{ id: 'style', hard: false, ok: false }],
    semantic: { addressesRequest: 0.9, claimsContradicted: 0.05, confidence: 0.8 },
    thresholds,
  })
  assert.equal(result.verdict, 'fulfilled')
})

test('no evidence is undetermined, not a silent pass', () => {
  assert.equal(decide({ rules: [], semantic: null, thresholds }).verdict, 'undetermined')
})

test('rules-only settlement passes with reduced confidence', () => {
  const result = decide({ rules: [{ id: 'tests', hard: true, ok: true }], semantic: null, thresholds })
  assert.equal(result.verdict, 'fulfilled')
  assert.equal(result.confidence, 0.6)
})

test('semantic pass requires the threshold', () => {
  assert.equal(decide({ semantic: { addressesRequest: 0.9, claimsContradicted: 0.05, confidence: 0.8 }, thresholds }).verdict, 'fulfilled')
  assert.equal(decide({ semantic: { addressesRequest: 0.5, claimsContradicted: 0.05, confidence: 0.8 }, thresholds }).verdict, 'undetermined')
  assert.equal(decide({ semantic: { addressesRequest: 0.2, claimsContradicted: 0.05, confidence: 0.8 }, thresholds }).verdict, 'violated')
})

test('contradicted claims are a process violation', () => {
  const result = decide({ semantic: { addressesRequest: 0.9, claimsContradicted: 0.85, confidence: 0.8 }, thresholds })
  assert.equal(result.verdict, 'violated')
  assert.equal(result.failureMode, 'process')
})

test('unstable samples are undetermined and capped', () => {
  const result = decide({ semantic: { addressesRequest: 0.75, claimsContradicted: 0.05, confidence: 0.9, unstable: true }, thresholds })
  assert.equal(result.verdict, 'undetermined')
  assert.ok(result.confidence <= 0.5)
})

test('truncation caps confidence at 0.5', () => {
  const result = decide({ semantic: { addressesRequest: 0.9, claimsContradicted: 0.05, confidence: 0.95 }, thresholds, truncated: true })
  assert.equal(result.verdict, 'fulfilled')
  assert.ok(result.confidence <= 0.5)
})

test('composite weights absolute, relative and process', () => {
  assert.equal(compositeScore({ absolute: 1, relative: 1, process: 1 }), 1)
  assert.equal(compositeScore({}), 0.5)
  assert.ok(Math.abs(compositeScore({ absolute: 1, relative: 0.5, process: 0.5 }) - 0.725) < 1e-9)
})

test('verdictScore pushes violated outcomes down and fulfilled up', () => {
  assert.ok(verdictScore('violated', { absolute: 0.9, relative: 0.9, process: 0.9 }) <= 0.3)
  assert.ok(verdictScore('fulfilled', { absolute: 0.1, relative: 0.1, process: 0.1 }) >= 0.7)
})


test('a semantic confidence below the floor is undetermined', () => {
  const result = decide({
    semantic: { addressesRequest: 0.95, claimsContradicted: 0.05, confidence: 0.2 },
    thresholds: { pass: 0.7, fail: 0.3, minConfidence: 0.45 },
  })
  assert.equal(result.verdict, 'undetermined')
})
