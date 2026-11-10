import test from 'node:test'
import assert from 'node:assert/strict'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { buildTools } from '../src/tools.js'
import { declareDev, feedTurn, makeEngine, makeJev, SESSION } from './helpers.js'

const BAD_OUTPUT = '--- a/src/a.js\n+++ b/src/a.js\n+const secret = "sk-abcdefghijklmnop123"'

test('declaration validates agent and capability ids', () => {
  const { engine } = makeEngine()
  assert.throws(() => engine.declare({ agent: 'bad agent', capability: 'code.change', statement: 'x'.repeat(20) }), /invalid agent/)
  assert.throws(() => engine.declare({ agent: 'preset:a', capability: 'Nope', statement: 'x'.repeat(20) }), /invalid capability/)
  assert.throws(() => engine.declare({ agent: 'preset:a', capability: 'code.change', statement: 'short' }), /falsifiable/)
})

test('re-declaring bumps the version and keeps the id', () => {
  const { engine } = makeEngine()
  const first = engine.declare({ agent: 'preset:a', capability: 'code.change', statement: 'deliver a minimal diff' })
  const second = engine.declare({ agent: 'preset:a', capability: 'code.change', statement: 'deliver a minimal diff v2' })
  assert.equal(second.promise.id, first.promise.id)
  assert.equal(second.promise.version, 2)
})

test('select returns guidance when nothing is declared', () => {
  const { engine } = makeEngine()
  const result = engine.select({ capability: 'code.change', need: 'fix it' }, { sessionId: SESSION.id })
  assert.equal(result.jobId, '')
  assert.equal(result.recommended, null)
  assert.match(result.guidance, /promise_declare/)
})

test('select creates a job and plans the level', () => {
  const { engine } = makeEngine()
  declareDev(engine)
  const result = engine.select({ capability: 'code.change', need: 'fix it', riskTier: 1 }, { sessionId: SESSION.id, turn: 1 })
  assert.ok(result.jobId.startsWith('job_'))
  assert.equal(result.recommended.agent, 'preset:developer')
  assert.equal(result.level, 2)
  assert.ok(engine.state.jobs.get(result.jobId))
})

test('settlement runs rules, updates trust and closes the job', async () => {
  const { engine } = makeEngine()
  declareDev(engine)
  feedTurn(engine.collector, SESSION, { turn: 1, tools: [{ name: 'edit', args: { path: 'src/a.js' } }], assistant: 'done' })
  const selected = engine.select({ capability: 'code.change', need: 'fix it', riskTier: 1 }, { sessionId: SESSION.id, turn: 1 })
  const result = await engine.settle({ jobId: selected.jobId, outcome: 'success', output: 'diff' }, { sessionId: SESSION.id, turn: 1 })
  assert.equal(result.verdict, 'fulfilled')
  assert.ok(result.trust.score > 0.5)
  assert.equal(result.trust.before, 0.5)
  assert.ok(engine.state.jobs.get(selected.jobId).closedAt)
  assert.equal(engine.state.assessments.size, 1)
})

test('a hard rule failure is a breach with probation', async () => {
  const { engine } = makeEngine()
  declareDev(engine)
  feedTurn(engine.collector, SESSION, { turn: 1, tools: [{ name: 'edit', args: { path: 'src/a.js' } }], assistant: 'done' })
  const selected = engine.select({ capability: 'code.change', need: 'fix it', riskTier: 1 }, { sessionId: SESSION.id, turn: 1 })
  const result = await engine.settle({ jobId: selected.jobId, outcome: 'success', output: BAD_OUTPUT }, { sessionId: SESSION.id, turn: 1 })
  assert.equal(result.verdict, 'violated')
  assert.equal(result.failureMode, 'rule:secrets')
  assert.equal(result.breach.action, 'probation')
  const promise = [...engine.state.promises.values()][0]
  assert.equal(promise.status, 'probation')
  assert.equal(engine.state.breaches.length, 1)
})

test('probation recovers after consecutive fulfilled settlements', async () => {
  const { engine } = makeEngine()
  declareDev(engine)
  feedTurn(engine.collector, SESSION, { turn: 1, tools: [{ name: 'edit', args: { path: 'src/a.js' } }], assistant: 'done' })
  const failing = engine.select({ capability: 'code.change', need: 'fix it', riskTier: 1 }, { sessionId: SESSION.id, turn: 1 })
  await engine.settle({ jobId: failing.jobId, outcome: 'success', output: BAD_OUTPUT }, { sessionId: SESSION.id, turn: 1 })
  assert.equal([...engine.state.promises.values()][0].status, 'probation')

  for (let turn = 2; turn <= 4; turn += 1) {
    feedTurn(engine.collector, SESSION, { turn, tools: [{ name: 'edit', args: { path: 'src/a.js' } }], assistant: 'done' })
    const selected = engine.select({ capability: 'code.change', need: 'fix it', riskTier: 1 }, { sessionId: SESSION.id, turn })
    const result = await engine.settle({ jobId: selected.jobId, outcome: 'success', output: 'diff' }, { sessionId: SESSION.id, turn })
    assert.equal(result.verdict, 'fulfilled')
  }
  assert.equal([...engine.state.promises.values()][0].status, 'active')
})

test('model-declared checks stay inert unless the operator opts in', async () => {
  const { engine } = makeEngine()
  engine.declare({
    agent: 'preset:developer',
    capability: 'code.change',
    statement: 'deliver a diff that passes the declared checks',
    // The model claims the check is trusted config; it must still be inert.
    checks: [{ id: 'pass', run: 'true', source: 'config' }],
    assessment: { policy: 'L1' },
  })
  feedTurn(engine.collector, SESSION, { turn: 1, tools: [{ name: 'edit', args: { path: 'src/a.js' } }], assistant: 'done' })
  const selected = engine.select({ capability: 'code.change', need: 'fix it', riskTier: 1 }, { sessionId: SESSION.id, turn: 1 })
  const result = await engine.settle({ jobId: selected.jobId, outcome: 'success', output: 'diff' }, { sessionId: SESSION.id, turn: 1 })
  assert.equal(result.verdict, 'undetermined')
  assert.equal([...engine.state.promises.values()][0].checks[0].source, 'model')
  assert.ok(result.rules.some((rule) => rule.skipped))
})

test('opted-in checks execute and can fulfil a promise', async () => {
  const { engine } = makeEngine({ config: { checks: { allowModelDeclared: true, allowlist: ['^true$'] } } })
  engine.declare({
    agent: 'preset:developer',
    capability: 'code.change',
    statement: 'deliver a diff that passes the declared checks',
    checks: [{ id: 'pass', run: 'true' }],
    assessment: { policy: 'L1' },
  })
  feedTurn(engine.collector, SESSION, { turn: 1, tools: [{ name: 'edit', args: { path: 'src/a.js' } }], assistant: 'done' })
  const selected = engine.select({ capability: 'code.change', need: 'fix it', riskTier: 1 }, { sessionId: SESSION.id, turn: 1 })
  const result = await engine.settle({ jobId: selected.jobId, outcome: 'success', output: 'diff' }, { sessionId: SESSION.id, turn: 1 })
  assert.equal(result.verdict, 'fulfilled')
  assert.equal(result.rules.find((rule) => rule.id === 'pass').ok, true)
})

test('semantic assessment runs at L3 and records the judge assessor', async () => {
  const jev = makeJev()
  const { engine } = makeEngine({ jev, config: { assessment: { sampleRate: 1 } } })
  declareDev(engine, { assessment: { policy: 'L3' } })
  feedTurn(engine.collector, SESSION, { turn: 1, tools: [{ name: 'edit', args: { path: 'src/a.js' } }], assistant: 'done' })
  const selected = engine.select({ capability: 'code.change', need: 'fix it', riskTier: 3 }, { sessionId: SESSION.id, turn: 1 })
  const result = await engine.settle({ jobId: selected.jobId, outcome: 'success', output: 'diff' }, { sessionId: SESSION.id, turn: 1 })
  assert.equal(result.verdict, 'fulfilled')
  assert.ok(result.layers.absolute > 0.5)
  const assessment = [...engine.state.assessments.values()][0]
  assert.equal(assessment.assessor, 'judge:jev')
  assert.equal(jev.calls.length, 1)
})

test('a Jev failure falls back to rules instead of breaking settlement', async () => {
  const jev = { configured: true, model: 'broken', async ask() { throw new Error('network down') } }
  const { engine } = makeEngine({ jev })
  declareDev(engine, { assessment: { policy: 'L3' } })
  feedTurn(engine.collector, SESSION, { turn: 1, tools: [{ name: 'edit', args: { path: 'src/a.js' } }], assistant: 'done' })
  const selected = engine.select({ capability: 'code.change', need: 'fix it', riskTier: 3 }, { sessionId: SESSION.id, turn: 1 })
  const result = await engine.settle({ jobId: selected.jobId, outcome: 'success', output: 'diff' }, { sessionId: SESSION.id, turn: 1 })
  assert.equal(result.verdict, 'fulfilled')
  assert.equal(result.semantic.skipped, true)
})

test('auto settlement closes an open job at turn end', async () => {
  const { engine } = makeEngine()
  declareDev(engine)
  feedTurn(engine.collector, SESSION, { turn: 1, tools: [{ name: 'edit', args: { path: 'src/a.js' } }], assistant: 'done' })
  const selected = engine.select({ capability: 'code.change', need: 'fix it', riskTier: 1 }, { sessionId: SESSION.id, turn: 1 })
  const result = await engine.autoSettle(SESSION.id, 1)
  assert.equal(result.settled, 1)
  assert.ok(engine.state.jobs.get(selected.jobId).closedAt)
  assert.equal(engine.state.jobs.get(selected.jobId).closedBy, 'auto')
})

test('ambiguous auto attribution is recorded but does not touch trust', async () => {
  const { engine } = makeEngine()
  engine.declare({ agent: 'preset:a', capability: 'code.change', statement: 'deliver a diff that passes tests', signals: { tool: ['bash'] } })
  engine.declare({ agent: 'preset:b', capability: 'code.review', statement: 'review a diff and report findings', signals: { tool: ['bash'] } })
  feedTurn(engine.collector, SESSION, { turn: 1, tools: [{ name: 'bash', args: { command: 'pnpm test' } }], assistant: 'done' })
  const result = await engine.autoSettle(SESSION.id, 1)
  assert.equal(result.unattributed, true)
  assert.equal(engine.state.counters.observations, 1)
  assert.equal(engine.state.trust.size, 0)
})

test('user feedback becomes a separate assessment', async () => {
  const { engine } = makeEngine()
  declareDev(engine)
  feedTurn(engine.collector, SESSION, { turn: 1, tools: [{ name: 'edit', args: { path: 'src/a.js' } }], assistant: 'done' })
  const selected = engine.select({ capability: 'code.change', need: 'fix it', riskTier: 1 }, { sessionId: SESSION.id, turn: 1 })
  await engine.settle({ jobId: selected.jobId, outcome: 'success', output: 'diff' }, { sessionId: SESSION.id, turn: 1 })
  const assessment = engine.attachFeedback({ sessionId: SESSION.id, messageId: 'msg-1', rating: 'negative', note: 'not what I asked' })
  assert.ok(assessment)
  assert.equal(assessment.assessor, 'user:feedback')
  assert.equal(engine.attachFeedback({ sessionId: SESSION.id, messageId: 'msg-1', rating: 'negative' }), null)
})

test('compose creates a superagent promise and an estimate', () => {
  const { engine } = makeEngine()
  engine.declare({ agent: 'preset:searcher', capability: 'research.search', statement: 'find relevant sources for a topic' })
  const result = engine.compose({
    name: 'research pack',
    external: { capability: 'research.brief', statement: 'produce a sourced brief within ten minutes' },
    children: [{ agent: 'preset:searcher', capability: 'research.search', weight: 1 }],
  })
  assert.equal(result.composition.id, 'compose:research-pack')
  assert.ok(engine.state.promises.has(result.externalPromise.id))
  assert.equal(result.health.estimate, true)
  assert.ok(result.health.evidenceMass >= 0)
})

test('inspect renders trust and summary without throwing', () => {
  const { engine } = makeEngine()
  declareDev(engine)
  assert.match(engine.inspect({ what: 'trust' }).text, /preset:developer/)
  assert.match(engine.inspect({ what: 'summary' }).text, /promises:/)
  assert.match(engine.inspect({ what: 'promise' }).text, /code.change/)
  assert.match(engine.inspect({ what: 'ledger' }).text, /chain:/)
})


test('settle tool output validates when semantic metadata is present', async () => {
  const jev = makeJev()
  const { engine, collector } = makeEngine({ jev, config: { assessment: { sampleRate: 1 } } })
  declareDev(engine, { assessment: { policy: 'L3' } })
  feedTurn(collector, SESSION, { turn: 1, tools: [{ name: 'edit', args: { path: 'src/a.js' } }], assistant: 'done' })
  const selected = engine.select({ capability: 'code.change', need: 'fix it', riskTier: 3 }, { sessionId: SESSION.id, turn: 1 })
  const tools = buildTools(engine, collector, () => {})
  const settleTool = tools.find((tool) => tool.name === 'promise_settle')
  const result = await settleTool.execute(
    { jobId: selected.jobId, outcome: 'success', output: 'diff' },
    { agent: { session: SESSION }, signal: new AbortController().signal },
  )
  assert.equal(result.verdict, 'fulfilled')
  assert.deepEqual(validateJsonSchemaValue(settleTool.output.schema, result, 'value'), [])
})
