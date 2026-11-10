import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionCollector } from '../src/collector.js'
import { SESSION, feedTurn } from './helpers.js'

test('collects changed files, tool results and assistant text', () => {
  const collector = new SessionCollector()
  feedTurn(collector, SESSION, {
    turn: 2,
    tools: [
      { name: 'edit', args: { path: 'src/a.js' } },
      { name: 'bash', args: { command: 'pnpm test' }, ok: false, text: 'failed' },
    ],
    assistant: 'changed src/a.js; tests still failing',
  })
  const observation = collector.observationFor(SESSION.id, { turn: 2 })
  assert.deepEqual(observation.changedFiles, ['src/a.js'])
  assert.equal(observation.toolResults.length, 2)
  assert.equal(observation.toolResults[1].ok, false)
  assert.match(observation.outputText, /still failing/)
  assert.ok(observation.durationMs >= 0)
})

test('maps feedback to the assistant message turn', () => {
  const collector = new SessionCollector()
  feedTurn(collector, SESSION, { turn: 3, assistant: 'result' })
  collector.observe(SESSION, {
    type: 'feedback/message-put',
    data: { sessionId: SESSION.id, item: { messageId: 'msg-3', rating: 'negative', note: 'wrong' } },
  })
  assert.equal(collector.messageTurn(SESSION.id, 'msg-3'), 3)
  const observation = collector.observationFor(SESSION.id, { turn: 3 })
  assert.equal(observation.feedback.length, 1)
  assert.equal(observation.feedback[0].rating, 'negative')
})

test('toolsInTurn is deduplicated', () => {
  const collector = new SessionCollector()
  feedTurn(collector, SESSION, {
    turn: 4,
    tools: [{ name: 'bash', args: { command: 'a' } }, { name: 'bash', args: { command: 'b' } }, { name: 'edit', args: { path: 'x' } }],
  })
  assert.deepEqual(collector.toolsInTurn(SESSION.id, 4).sort(), ['bash', 'edit'])
})

test('unknown sessions yield an empty observation', () => {
  const collector = new SessionCollector()
  const observation = collector.observationFor('nope')
  assert.deepEqual(observation.changedFiles, [])
  assert.equal(observation.outputText, '')
})

test('captures policy from the child session without hashing the task prompt', () => {
  const collector = new SessionCollector()
  const session = { id: 'child-policy', header: { agentPreset: 'cordis' } }
  collector.observe(session, { type: 'subagent/descriptor', data: { agentProvider: 'deepseek-account', agentModel: 'deepseek-flash', agentReasoningEffort: 'high' } })
  collector.observe(session, { type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'You are a reviewer.' }] } } })
  collector.observe(session, { type: 'request/header', data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }, tools: [{ name: 'read' }, { name: 'bash' }] } } })
  const policy = collector.policyOf('child-policy', { contractHash: 'contract-1' })
  assert.equal(policy.agentPreset, 'cordis')
  assert.equal(policy.provider, 'deepseek-account')
  assert.equal(policy.model, 'deepseek-flash')
  assert.equal(policy.reasoningEffort, 'high')
  assert.equal(policy.contractHash, 'contract-1')
  assert.match(policy.id, /^p_/)
})
