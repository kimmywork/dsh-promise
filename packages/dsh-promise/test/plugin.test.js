import test from 'node:test'
import assert from 'node:assert/strict'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply, Config, inject, name } from '../src/index.js'
import { tempDir } from './helpers.js'

function fakeContext(services = {}) {
  const tools = []
  const sections = []
  const handlers = []
  const ctx = {
    tools: { register: (tool) => { tools.push(tool); return () => {} } },
    systemPrompt: { section: (section) => { sections.push(section); return () => {} } },
    on: (event, handler) => { handlers.push({ event, handler }); return () => {} },
    get: (name) => services[name],
    logger: () => ({ warn: () => {}, info: () => {} }),
  }
  return { ctx, tools, sections, handlers }
}

test('exposes the cordis plugin contract', () => {
  assert.equal(name, 'promise')
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'sessions'])
  assert.ok(Config)
})

test('registers five tools, one prompt section and the session listener', () => {
  const { ctx, tools, sections, handlers } = fakeContext()
  apply(ctx, Config({ dataDir: tempDir(), jev: { enabled: false } }))
  assert.deepEqual(tools.map((tool) => tool.name), [
    'promise_declare',
    'promise_select',
    'promise_settle',
    'promise_delegate',
    'promise_inspect',
    'promise_compose',
  ])
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'promise:protocol')
  assert.equal(sections[0].order, 1200)
  assert.ok(handlers.some((handler) => handler.event === 'session/event'))
})

test('the prompt section stays empty until a promise exists', async () => {
  const { ctx, tools, sections } = fakeContext()
  apply(ctx, Config({ dataDir: tempDir(), jev: { enabled: false } }))
  assert.equal(sections[0].text({}), '')
  const declare = tools.find((tool) => tool.name === 'promise_declare')
  await declare.execute({
    agent: 'preset:developer',
    capability: 'code.change',
    statement: 'deliver a diff that passes its checks',
  }, {})
  assert.match(sections[0].text({}), /Promise protocol/)
})

test('disabled means no registrations at all', () => {
  const { ctx, tools, sections } = fakeContext()
  apply(ctx, Config({ enabled: false, dataDir: tempDir() }))
  assert.equal(tools.length, 0)
  assert.equal(sections.length, 0)
})

test('the session listener tolerates events without a promise', () => {
  const { ctx, handlers } = fakeContext()
  apply(ctx, Config({ dataDir: tempDir(), jev: { enabled: false } }))
  const handler = handlers.find((entry) => entry.event === 'session/event').handler
  const session = { id: 'sess-x', header: { cwd: process.cwd() } }
  handler(session, { type: 'turn/start', data: { turn: 1 } })
  handler(session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } })
  handler(session, { type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'c1', content: [], isError: false } } })
  handler(session, { type: 'turn/end', data: { turn: 1 } })
  handler(session, { type: 'feedback/message-put', data: { sessionId: 'sess-x', item: { messageId: 'm1', rating: 'positive' } } })
})

test('a bad event payload never escapes the listener', () => {
  const { ctx, handlers } = fakeContext()
  apply(ctx, Config({ dataDir: tempDir(), jev: { enabled: false } }))
  const handler = handlers.find((entry) => entry.event === 'session/event').handler
  assert.doesNotThrow(() => handler(null, null))
  assert.doesNotThrow(() => handler({ id: 's' }, { type: 'tool/result', data: { message: null } }))
})

test('tools round-trip through declare, select and settle', async () => {
  const { ctx, tools } = fakeContext()
  apply(ctx, Config({ dataDir: tempDir(), jev: { enabled: false } }))
  const agent = { session: { id: 'sess-tools', header: { cwd: process.cwd() } } }
  const exec = { agent, signal: new AbortController().signal }
  const declare = tools.find((tool) => tool.name === 'promise_declare')
  const select = tools.find((tool) => tool.name === 'promise_select')
  const settle = tools.find((tool) => tool.name === 'promise_settle')

  const declared = await declare.execute({
    agent: 'preset:developer',
    capability: 'code.change',
    statement: 'deliver a diff that stays in scope and passes its checks',
    rules: [{ id: 'scope', kind: 'files-within', globs: ['src/**'] }],
  }, exec)
  assert.ok(declared.promiseId)
  assert.deepEqual(validateJsonSchemaValue(declare.output.schema, declared, 'value'), [])

  const selected = await select.execute({ capability: 'code.change', need: 'fix the bug', riskTier: 1 }, exec)
  assert.ok(selected.jobId)
  assert.equal(selected.hasCandidate, true)
  assert.deepEqual(validateJsonSchemaValue(select.output.schema, selected, 'value'), [])

  const settled = await settle.execute({ jobId: selected.jobId, outcome: 'success', output: 'diff' }, exec)
  assert.equal(settled.verdict, 'fulfilled')
  assert.deepEqual(validateJsonSchemaValue(settle.output.schema, settled, 'value'), [])
  assert.match(settled.text, /fulfilled/)
})

test('Jev connection fields are volatile and the key is a secret', () => {
  const jev = Config.dict.jev.dict
  assert.equal(jev.apiKey.meta.role, 'secret')
  assert.equal(jev.apiKey.meta.volatile, true)
  assert.equal(jev.baseUrl.meta.volatile, true)
  assert.equal(jev.model.meta.volatile, true)
})


test('a bound delegation result carries a promise annotation for the tool card', async () => {
  const teams = {
    listMembers: () => [{ id: 'solo-session', name: 'solo', status: 'running' }],
    sendMessage: async () => ({}),
    spawnTeammate: async () => ({}),
  }
  const { ctx, tools, handlers } = fakeContext({ agentTeams: teams })
  apply(ctx, Config({ dataDir: tempDir(), jev: { enabled: false } }))
  const declare = tools.find((tool) => tool.name === 'promise_declare')
  await declare.execute({ agent: 'team:solo', capability: 'code.solo', statement: 'do the delegated task' }, {})

  const handler = handlers.find((entry) => entry.event === 'tools/post-execute').handler
  const exec = {
    name: 'spawn_teammate',
    arguments: { name: 'solo', prompt: 'do it' },
    agent: { session: { id: 'sess-ui' } },
  }
  const result = {
    isError: false,
    content: [{ type: 'text', text: '{"member":{"target":"solo"}}' }],
    value: { member: { target: 'solo', status: 'running' } },
  }
  const decision = await handler(exec, result, async () => ({ kind: 'accept' }))
  assert.equal(decision.kind, 'accept')
  assert.ok(decision.content.some((block) => block.type === 'text' && block.text.includes('promise code.solo')))
})
