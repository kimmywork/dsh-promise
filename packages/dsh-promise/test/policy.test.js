import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPolicy, contractHash } from '../src/policy.js'

test('policy identity is stable for the same behavior configuration', () => {
  const a = buildPolicy({ model: 'deepseek-flash', provider: 'deepseek-account', agentPreset: 'cordis', systemPromptHash: 'aaa', toolsHash: 'ttt', contractHash: 'ccc' })
  const b = buildPolicy({ model: 'deepseek-flash', provider: 'deepseek-account', agentPreset: 'cordis', systemPromptHash: 'aaa', toolsHash: 'ttt', contractHash: 'ccc' })
  assert.equal(a.id, b.id)
  assert.match(a.id, /^p_[0-9a-f]{12}$/)
})

test('a model or system-prompt change creates a new policy', () => {
  const base = { model: 'deepseek-flash', provider: 'deepseek-account', agentPreset: 'cordis', systemPromptHash: 'aaa', toolsHash: 'ttt', contractHash: 'ccc' }
  const gpt = buildPolicy({ ...base, model: 'gpt-5' })
  const prompt = buildPolicy({ ...base, systemPromptHash: 'bbb' })
  assert.notEqual(gpt.id, buildPolicy(base).id)
  assert.notEqual(prompt.id, buildPolicy(base).id)
  assert.notEqual(gpt.id, prompt.id)
})

test('an unknown policy is legacy, not a random identity', () => {
  assert.equal(buildPolicy({}).id, 'legacy')
})

test('the contract hash covers statement, rules and requirements but not the task prompt', () => {
  const promise = { statement: 'review with file:line', qos: { requiredFormat: 'markdown' }, requirements: [{ id: 'r', text: 'findings' }], rules: [{ id: 'sections', kind: 'required-sections' }], assessment: { policy: 'L3' } }
  const a = contractHash(promise)
  const b = contractHash({ ...promise, request: 'review THIS dynamic prompt' })
  assert.equal(a, b)
  assert.notEqual(a, contractHash({ ...promise, statement: 'review anything' }))
  assert.notEqual(a, contractHash({ ...promise, rules: [] }))
})
