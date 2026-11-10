import test from 'node:test'
import assert from 'node:assert/strict'
import { planLevel, shouldSample } from '../src/planner.js'

const plan = (input) => planLevel(input, { coldStartMass: 5, defaultLevel: 1 })

test('risk tier sets the base level', () => {
  assert.equal(plan({ riskTier: 0, mass: 100 }).level, 0)
  assert.equal(plan({ riskTier: 1, mass: 100 }).level, 1)
  assert.equal(plan({ riskTier: 2, mass: 100 }).level, 2)
  assert.equal(plan({ riskTier: 3, mass: 100 }).level, 3)
})

test('irreversible actions are always L3', () => {
  assert.equal(plan({ riskTier: 0, reversible: false, mass: 100 }).level, 3)
})

test('high value output is at least L2', () => {
  assert.equal(plan({ riskTier: 0, value: 'high', mass: 100 }).level, 2)
})

test('cold start raises scrutiny by one level', () => {
  const result = plan({ riskTier: 0, mass: 0 })
  assert.equal(result.level, 1)
  assert.ok(result.reasons.some((reason) => reason.includes('cold start')))
})

test('declared policy can only increase the level', () => {
  assert.equal(plan({ riskTier: 1, mass: 100, declaredPolicy: 'L3' }).level, 3)
  assert.equal(plan({ riskTier: 3, mass: 100, declaredPolicy: 'L1' }).level, 3)
  assert.equal(plan({ riskTier: 1, mass: 100, declaredPolicy: 'auto' }).level, 1)
})

test('budget exhaustion degrades to L1 and says so', () => {
  const result = plan({ riskTier: 3, mass: 100, budgetExhausted: true })
  assert.equal(result.level, 1)
  assert.ok(result.reasons.some((reason) => reason.includes('budget')))
})

test('missing risk tier falls back to the default level', () => {
  assert.equal(plan({ mass: 100 }).level, 1)
})

test('sampling is deterministic with an injected random source', () => {
  assert.equal(shouldSample(1), true)
  assert.equal(shouldSample(0), false)
  assert.equal(shouldSample(0.5, () => 0.2), true)
  assert.equal(shouldSample(0.5, () => 0.8), false)
})
