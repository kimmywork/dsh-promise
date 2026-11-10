import test from 'node:test'
import assert from 'node:assert/strict'
import { invokeHint, rankCandidates } from '../src/router.js'

const promise = (agent, capability, extra = {}) => ({
  id: `p-${agent}`,
  agent,
  capability,
  status: 'active',
  qos: { maxLatencyMs: 60_000, minQuality: 0.6, requiredFormat: 'diff' },
  assessment: { policy: 'L2' },
  ...extra,
})

function lookupFrom(map) {
  return (agent, capability) => map[`${agent}|${capability}`] ?? { score: 0.5, lower: 0.5, mass: 0, count: 0 }
}

test('evidence beats a cold-start neighbour', () => {
  const lookup = lookupFrom({
    'preset:proven|code.change': { score: 0.82, lower: 0.74, mass: 20, count: 22 },
    'preset:new|code.change': { score: 0.6, lower: 0.48, mass: 2, count: 2 },
  })
  const { candidates } = rankCandidates({
    promises: [promise('preset:new', 'code.change'), promise('preset:proven', 'code.change')],
    lookup,
    constraints: {},
    totalJobs: 30,
  })
  assert.equal(candidates[0].agent, 'preset:proven')
  assert.ok(candidates[0].reasons.length > 0)
  assert.ok(candidates[1].explore > 0)
})

test('hard latency constraints exclude infeasible promises', () => {
  const lookup = lookupFrom({ 'preset:slow|code.change': { score: 0.9, lower: 0.85, mass: 30, count: 30 } })
  const { candidates } = rankCandidates({
    promises: [promise('preset:slow', 'code.change', { qos: { maxLatencyMs: 600_000 } })],
    lookup,
    constraints: { maxLatencyMs: 60_000 },
  })
  assert.equal(candidates.length, 0)
})

test('probation carries a penalty and a reason', () => {
  const lookup = lookupFrom({
    'preset:a|code.change': { score: 0.8, lower: 0.72, mass: 10, count: 12 },
    'preset:b|code.change': { score: 0.8, lower: 0.72, mass: 10, count: 12 },
  })
  const { candidates } = rankCandidates({
    promises: [promise('preset:a', 'code.change'), promise('preset:b', 'code.change', { status: 'probation' })],
    lookup,
    constraints: {},
  })
  assert.equal(candidates[0].agent, 'preset:a')
  assert.ok(candidates.find((candidate) => candidate.agent === 'preset:b').reasons.some((reason) => reason.includes('probation')))
})

test('suspended and draft promises never route', () => {
  const lookup = lookupFrom({})
  const { candidates } = rankCandidates({
    promises: [promise('preset:s', 'code.change', { status: 'suspended' }), promise('preset:d', 'code.change', { status: 'draft' })],
    lookup,
    constraints: {},
  })
  assert.equal(candidates.length, 0)
})

test('format mismatch is penalised but not excluded', () => {
  const lookup = lookupFrom({ 'preset:md|code.change': { score: 0.8, lower: 0.72, mass: 10, count: 10 } })
  const { candidates } = rankCandidates({
    promises: [promise('preset:md', 'code.change', { qos: { requiredFormat: 'markdown' } })],
    lookup,
    constraints: { requiredFormat: 'diff' },
  })
  assert.equal(candidates.length, 0, 'a different required format is a hard incompatibility')
})

test('invoke hints map agent ids to concrete calls', () => {
  assert.deepEqual(invokeHint('preset:developer'), { kind: 'subagent', agentPreset: 'developer' })
  assert.deepEqual(invokeHint('tool:web_search'), { kind: 'tool', tool: 'web_search' })
  assert.deepEqual(invokeHint('compose:pack'), { kind: 'subagent', composition: 'pack' })
  assert.equal(invokeHint('weird').kind, 'other')
})
