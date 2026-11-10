import test from 'node:test'
import assert from 'node:assert/strict'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { buildTools } from '../src/tools.js'
import { declareDev, feedTurn, makeConfig, makeEngine, makeJev, SESSION, tempDir } from './helpers.js'
import { Ledger } from '../src/ledger.js'
import { SessionCollector } from '../src/collector.js'
import { PromiseEngine } from '../src/engine.js'

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
  engine.declare({ agent: 'preset:a', capability: 'code.change', statement: 'deliver a diff that passes tests', signals: { tool: ['bash'], autoAttribute: true } })
  engine.declare({ agent: 'preset:b', capability: 'code.review', statement: 'review a diff and report findings', signals: { tool: ['bash'], autoAttribute: true } })
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


test('signal attribution is off unless the promise opts in', async () => {
  const { engine } = makeEngine()
  engine.declare({ agent: 'preset:a', capability: 'code.change', statement: 'deliver a diff that passes tests', signals: { tool: ['bash'] } })
  feedTurn(engine.collector, SESSION, { turn: 1, tools: [{ name: 'bash', args: { command: 'ls' } }], assistant: 'done' })
  const result = await engine.autoSettle(SESSION.id, 1)
  assert.equal(result.settled, 0)
  assert.equal(engine.state.counters.observations, 0)
  assert.equal(engine.state.jobs.size, 0)
})


test('select guidance names the right invocation for each agent family', () => {
  const { engine } = makeEngine()

  engine.declare({ agent: 'preset:developer', capability: 'code.change', statement: 'deliver a diff that stays in scope' })
  const preset = engine.select({ capability: 'code.change', need: 'fix it' }, { sessionId: SESSION.id, turn: 1 })
  assert.match(preset.guidance, /agent_preset="developer"/)

  engine.declare({ agent: 'team:reviewer', capability: 'code.review', statement: 'review a diff and list findings' })
  const team = engine.select({ capability: 'code.review', need: 'review it' }, { sessionId: SESSION.id, turn: 1 })
  assert.match(team.guidance, /spawn or message teammate "reviewer"/)

  engine.declare({ agent: 'bot:Alice', capability: 'research.brief', statement: 'write a sourced brief on a topic' })
  const bot = engine.select({ capability: 'research.brief', need: 'write a brief' }, { sessionId: SESSION.id, turn: 1 })
  assert.match(bot.guidance, /message_bot/)
})


test('a delegated job is linked, skipped by auto-settle, then settled by the child', async () => {
  const { engine, collector } = makeEngine()
  declareDev(engine)
  feedTurn(collector, SESSION, { turn: 1, tools: [{ name: 'edit', args: { path: 'src/a.js' } }], assistant: 'started' })
  const selected = engine.select({ capability: 'code.change', need: 'fix it', riskTier: 1 }, { sessionId: SESSION.id, turn: 1 })
  engine.linkDelegation(selected.jobId, { kind: 'team', name: 'dev', sessionId: 'team-session-1' })
  assert.equal(engine.state.jobs.get(selected.jobId).delegation.kind, 'team')

  // The Lead turn ending must not settle a delegated job with the Lead's own output.
  await engine.autoSettle(SESSION.id, 1)
  assert.equal(engine.state.jobs.get(selected.jobId).closedAt, null)

  // The teammate's own turn provides the output and tool traces.
  const child = { id: 'team-session-1', header: { cwd: process.cwd() } }
  feedTurn(collector, child, { turn: 1, tools: [{ name: 'edit', args: { path: 'src/b.js' } }], assistant: 'done: fixed src/b.js' })
  const result = await engine.settleDelegated(selected.jobId)
  assert.ok(result)
  assert.equal(result.verdict, 'fulfilled')
  assert.equal(engine.state.jobs.get(selected.jobId).closedBy, 'delegated')
  assert.match(engine.state.jobs.get(selected.jobId).outputRef ?? '', /^$|./)
})

test('promise_delegate spawns a teammate and links the job', async () => {
  const { engine, collector } = makeEngine()
  declareDev(engine, { agent: 'team:dev' })
  feedTurn(collector, SESSION, { turn: 1, tools: [{ name: 'edit', args: { path: 'src/a.js' } }], assistant: 'started' })
  const selected = engine.select({ capability: 'code.change', need: 'fix it', riskTier: 1 }, { sessionId: SESSION.id, turn: 1 })
  const spawned = []
  const teams = {
    listMembers: () => [],
    spawnTeammate: async (_caller, request) => {
      spawned.push(request)
      return { member: { id: 'team-session-9', name: request.name, status: 'running' } }
    },
    sendMessage: async () => ({}),
  }
  engine.services.watchIntervalMs = 60_000
  const tools = buildTools(engine, collector, () => {}, { getTeams: () => teams, getSubagents: () => null })
  const delegate = tools.find((tool) => tool.name === 'promise_delegate')
  const result = await delegate.execute(
    { jobId: selected.jobId, prompt: 'fix the bug in src/a.js' },
    { agent: { session: SESSION }, signal: new AbortController().signal },
  )
  assert.equal(result.dispatched, true)
  assert.equal(result.family, 'team')
  assert.equal(spawned.length, 1)
  assert.match(spawned[0].prompt[0].text, /PROMISE CONTRACT/)
  assert.match(spawned[0].prompt[0].text, /PROMISE ACCEPTED/)
  assert.equal(engine.state.jobs.get(selected.jobId).delegation.sessionId, 'team-session-9')
  assert.deepEqual(validateJsonSchemaValue(delegate.output.schema, result, 'value'), [])
  for (const timer of engine.watchers.values()) clearInterval(timer)
  engine.watchers.clear()
})


test('direct spawn_teammate / send_message / subagent calls bind to an open job', () => {
  const { engine, collector } = makeEngine()
  declareDev(engine, { agent: 'team:dev', capability: 'code.team' })
  declareDev(engine, { agent: 'preset:developer', capability: 'code.sub' })

  const teamJob = engine.select({ capability: 'code.team', need: 'team fix' }, { sessionId: SESSION.id, turn: 1 })
  const bound = engine.bindToolDelegation({
    toolName: 'spawn_teammate',
    args: { name: 'dev' },
    value: { member: { id: 'team-session-2', name: 'dev', status: 'running' } },
    callerSessionId: SESSION.id,
    callerAgent: { session: SESSION },
  })
  assert.equal(bound, teamJob.jobId)
  assert.equal(engine.state.jobs.get(teamJob.jobId).delegation.sessionId, 'team-session-2')

  const subJob = engine.select({ capability: 'code.sub', need: 'sub fix' }, { sessionId: SESSION.id, turn: 2 })
  const subBound = engine.bindToolDelegation({
    toolName: 'subagent',
    args: { agent_preset: 'developer' },
    value: { kind: 'activation', subagentId: 'sub-session-1' },
    callerSessionId: SESSION.id,
    callerAgent: { session: SESSION },
  })
  assert.equal(subBound, subJob.jobId)
  assert.equal(engine.state.jobs.get(subJob.jobId).delegation.kind, 'subagent')
  for (const timer of engine.watchers.values()) clearInterval(timer)
  engine.watchers.clear()
})

test('an ambiguous delegation binds nothing', () => {
  const { engine } = makeEngine()
  declareDev(engine, { agent: 'team:dev' })
  declareDev(engine, { capability: 'code.review', agent: 'team:dev', statement: 'review a diff and report findings' })
  engine.select({ capability: 'code.change', need: 'a' }, { sessionId: SESSION.id, turn: 1 })
  engine.select({ capability: 'code.review', need: 'b' }, { sessionId: SESSION.id, turn: 1 })
  const bound = engine.bindToolDelegation({
    toolName: 'spawn_teammate',
    args: { name: 'dev' },
    value: { member: { id: 'team-session-3', name: 'dev', status: 'running' } },
    callerSessionId: SESSION.id,
    callerAgent: { session: SESSION },
  })
  assert.equal(bound, null)
})


const VIOLATING = {
  addresses_request: { type: 'noul', noul: 0.05 },
  claims_contradicted: { type: 'noul', noul: 0.1 },
  absolute_quality: { type: 'score', score: 0.6, confidence: 0.6 },
  input_quality: { type: 'score', score: 3, confidence: 0.6 },
  process_quality: { type: 'score', score: 0.8, confidence: 0.6 },
  failure_mode: { type: 'choice', choice: 'capability', confidence: 0.7 },
  unmet_requirement: { type: 'choice', choice: 'fix', confidence: 0.8 },
}

test('a violated settlement returns a schema-valid breach payload', async () => {
  const jev = makeJev({ answers: VIOLATING })
  const { engine, collector } = makeEngine({ jev, config: { assessment: { sampleRate: 1 } } })
  declareDev(engine, { assessment: { policy: 'L3' } })
  feedTurn(collector, SESSION, { turn: 1, tools: [{ name: 'edit', args: { path: 'src/a.js' } }], assistant: 'done' })
  const selected = engine.select({ capability: 'code.change', need: 'fix it', riskTier: 3 }, { sessionId: SESSION.id, turn: 1 })
  const tools = buildTools(engine, collector, () => {}, {})
  const settleTool = tools.find((tool) => tool.name === 'promise_settle')
  const result = await settleTool.execute(
    { jobId: selected.jobId, outcome: 'success', output: 'diff' },
    { agent: { session: SESSION }, signal: new AbortController().signal },
  )
  assert.equal(result.verdict, 'violated')
  assert.ok(result.breach?.action)
  assert.deepEqual(validateJsonSchemaValue(settleTool.output.schema, result, 'value'), [])
})

test('enrichment applies a breach with its before-snapshot and is idempotent', async () => {
  const jev = makeJev({ answers: VIOLATING })
  const { engine, collector } = makeEngine({ jev, config: { trust: { coldStartMass: 0 }, assessment: { sampleRate: 1 } } })
  engine.declare({
    agent: 'preset:enrich',
    capability: 'code.enrich',
    statement: 'deliver a diff that implements the request',
    rules: [{ id: 'scope', kind: 'files-within', globs: ['src/**'] }],
    requirements: [{ id: 'fix', text: 'the requested behavior is implemented' }],
    assessment: { policy: 'L1' },
  })
  feedTurn(collector, SESSION, { turn: 1, tools: [{ name: 'edit', args: { path: 'src/a.js' } }], assistant: 'done' })
  const selected = engine.select({ capability: 'code.enrich', need: 'fix it', riskTier: 0 }, { sessionId: SESSION.id, turn: 1 })
  await engine.autoSettle(SESSION.id, 1)
  assert.equal(engine.state.jobs.get(selected.jobId).closedBy, 'auto')

  engine.declare({
    agent: 'preset:enrich',
    capability: 'code.enrich',
    statement: 'deliver a diff that implements the request',
    rules: [{ id: 'scope', kind: 'files-within', globs: ['src/**'] }],
    requirements: [{ id: 'fix', text: 'the requested behavior is implemented' }],
    assessment: { policy: 'L3' },
  })
  const enriched = await engine.settle({ jobId: selected.jobId, output: 'diff' }, { sessionId: SESSION.id, turn: 1 })
  assert.equal(enriched.verdict, 'violated')
  assert.equal([...engine.state.promises.values()].find((promise) => promise.capability === 'code.enrich').status, 'probation')

  const again = await engine.settle({ jobId: selected.jobId, output: 'diff' }, { sessionId: SESSION.id, turn: 1 })
  assert.match(again.note, /already enriched/)
})

test('model-declared thresholds are clamped or ignored when unordered', () => {
  const { engine } = makeEngine()
  const { promise } = engine.declare({
    agent: 'preset:x',
    capability: 'code.thresholds',
    statement: 'deliver something checkable',
    assessment: { policy: 'L2', passThreshold: -1, failThreshold: 10, minConfidence: 7 },
  })
  assert.equal(promise.assessment.passThreshold, undefined)
  assert.equal(promise.assessment.failThreshold, undefined)
  assert.equal(promise.assessment.minConfidence, 1)
})

test('delegation links are rebuilt after a restart', () => {
  const dir = tempDir()
  const { engine } = makeEngine({ dir })
  declareDev(engine, { agent: 'team:restart' })
  const selected = engine.select({ capability: 'code.change', need: 'fix' }, { sessionId: SESSION.id, turn: 1 })
  engine.linkDelegation(selected.jobId, { kind: 'team', name: 'restart', sessionId: 'team-session-r' })
  for (const timer of engine.watchers.values()) clearInterval(timer)
  engine.watchers.clear()

  const config = makeConfig({})
  const ledger = new Ledger({ dir, snapshotEvery: 50, prior: config.trust.prior, halfLifeDays: config.trust.halfLifeDays, logger: () => {} }).open()
  const reopened = new PromiseEngine({ config, ledger, collector: new SessionCollector(), jev: null, logger: () => {} })
  assert.equal(reopened.delegationBySession.get('team-session-r'), selected.jobId)
})

test('a timed-out host check is skipped, not treated as a violation', async () => {
  const { engine, collector } = makeEngine({
    config: { trust: { coldStartMass: 0 }, checks: { allowModelDeclared: true, allowlist: ['^sleep$'] } },
  })
  engine.declare({
    agent: 'preset:slow',
    capability: 'code.slow',
    statement: 'deliver a result whose check finishes',
    checks: [{ id: 'slow', run: 'sleep 2', timeoutMs: 100 }],
    assessment: { policy: 'L1' },
  })
  feedTurn(collector, SESSION, { turn: 1, tools: [{ name: 'edit', args: { path: 'src/a.js' } }], assistant: 'done' })
  const selected = engine.select({ capability: 'code.slow', need: 'run it', riskTier: 0 }, { sessionId: SESSION.id, turn: 1 })
  const result = await engine.settle({ jobId: selected.jobId, outcome: 'success', output: 'diff' }, { sessionId: SESSION.id, turn: 1 })
  assert.equal(result.rules.find((rule) => rule.id === 'slow').skipped, true)
  assert.equal(result.verdict, 'undetermined')
})


test('spawn binding resolves the teammate session id from the roster', () => {
  const { engine } = makeEngine()
  declareDev(engine, { agent: 'team:dev2', capability: 'code.team2' })
  const selected = engine.select({ capability: 'code.team2', need: 'do it' }, { sessionId: SESSION.id, turn: 1 })
  const teams = { listMembers: () => [{ id: 'team-77', name: 'dev2', status: 'running' }], sendMessage: async () => ({}), spawnTeammate: async () => ({}) }
  const bound = engine.bindToolDelegation({
    toolName: 'spawn_teammate',
    args: { name: 'dev2' },
    value: { member: { target: 'dev2', role: 'teammate', status: 'running' } },
    callerSessionId: SESSION.id,
    callerAgent: { session: SESSION },
    teams,
  })
  assert.equal(bound, selected.jobId)
  assert.equal(engine.state.jobs.get(selected.jobId).delegation.sessionId, 'team-77')
  for (const timer of engine.watchers.values()) clearInterval(timer)
  engine.watchers.clear()
})

test('an explicit decline closes the job without trust evidence', async () => {
  const { engine, collector } = makeEngine()
  declareDev(engine, { agent: 'team:decliner', capability: 'code.decline' })
  const selected = engine.select({ capability: 'code.decline', need: 'do it' }, { sessionId: SESSION.id, turn: 1 })
  engine.linkDelegation(selected.jobId, { kind: 'team', name: 'decliner', sessionId: 'decl-session' })
  feedTurn(collector, { id: 'decl-session', header: { cwd: process.cwd() } }, { assistant: 'PROMISE DECLINED: outside my scope' })
  const result = await engine.settleDelegated(selected.jobId)
  assert.equal(result.verdict, 'undetermined')
  assert.equal(engine.state.counters.declined, 1)
  assert.equal(engine.trustFor('team:decliner', 'code.decline').count, 0)
  assert.equal(engine.state.jobs.get(selected.jobId).closedBy, 'delegated')
})

test('an explicit acceptance is recorded and the job settles', async () => {
  const { engine, collector } = makeEngine()
  declareDev(engine, { agent: 'team:accepter', capability: 'code.accept' })
  const selected = engine.select({ capability: 'code.accept', need: 'do it' }, { sessionId: SESSION.id, turn: 1 })
  engine.linkDelegation(selected.jobId, { kind: 'team', name: 'accepter', sessionId: 'accept-session' })
  feedTurn(collector, { id: 'accept-session', header: { cwd: process.cwd() } }, {
    tools: [{ name: 'edit', args: { path: 'src/a.js' } }],
    assistant: 'PROMISE ACCEPTED\ndone: changed src/a.js',
  })
  const result = await engine.settleDelegated(selected.jobId)
  assert.equal(result.verdict, 'fulfilled')
  assert.equal(engine.state.counters.accepted, 1)
  assert.ok(engine.trustFor('team:accepter', 'code.accept').count >= 1)
})


test('spawn_teammate opens the job implicitly when the agent has one active promise', async () => {
  const { engine, collector } = makeEngine()
  engine.declare({
    agent: 'team:solo',
    capability: 'code.solo',
    statement: 'do the delegated task and report the result',
    rules: [{ id: 'min', kind: 'min-bytes', min: 1 }],
  })
  const teams = {
    listMembers: () => [{ id: 'solo-session', name: 'solo', status: 'running' }],
    sendMessage: async () => ({}),
    spawnTeammate: async () => ({}),
  }
  const bound = engine.bindToolDelegation({
    toolName: 'spawn_teammate',
    args: { name: 'solo', prompt: 'do the thing' },
    value: { member: { target: 'solo', role: 'teammate', status: 'running' } },
    callerSessionId: SESSION.id,
    callerAgent: { session: SESSION },
    teams,
  })
  assert.ok(bound)
  const job = engine.state.jobs.get(bound)
  assert.equal(job.attribution, 'implicit')
  assert.equal(job.request, 'do the thing')
  assert.equal(job.delegation.sessionId, 'solo-session')

  feedTurn(collector, { id: 'solo-session', header: { cwd: process.cwd() } }, { assistant: 'done' })
  const result = await engine.settleDelegated(bound)
  assert.equal(result.verdict, 'fulfilled')
  for (const timer of engine.watchers.values()) clearInterval(timer)
  engine.watchers.clear()
})

test('a delegated settlement records the child policy and trusts it separately', async () => {
  const { engine, collector } = makeEngine()
  engine.declare({
    agent: 'team:policy',
    capability: 'code.policy',
    statement: 'review the change and report findings with file:line',
    rules: [{ id: 'min', kind: 'min-bytes', min: 1 }],
    assessment: { policy: 'L1' },
  })
  const selected = engine.select({ capability: 'code.policy', need: 'review', riskTier: 1 }, { sessionId: SESSION.id, turn: 1 })
  const child = { id: 'child-policy-session', header: { cwd: process.cwd(), agentPreset: 'cordis' } }
  engine.linkDelegation(selected.jobId, { kind: 'team', name: 'policy', sessionId: child.id })
  collector.observe(child, { type: 'subagent/descriptor', data: { agentProvider: 'deepseek-account', agentModel: 'deepseek-flash', agentReasoningEffort: 'high' } })
  collector.observe(child, { type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'You are a reviewer.' }] } } })
  collector.observe(child, { type: 'request/header', data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' }, tools: [{ name: 'read' }] } } })
  feedTurn(collector, child, { assistant: '## Findings\nreviewed src/a.js:1 — ok' })
  const result = await engine.settleDelegated(selected.jobId)
  assert.equal(result.verdict, 'fulfilled')
  const assessment = [...engine.state.assessments.values()].find((entry) => entry.jobId === selected.jobId)
  assert.equal(assessment.policy.model, 'deepseek-flash')
  assert.equal(assessment.policy.agentPreset, 'cordis')
  const exact = engine.trustFor('team:policy', 'code.policy', assessment.policy.id)
  assert.equal(exact.count, 1)
  const family = engine.trustFor('team:policy', 'code.policy')
  assert.equal(family.count, 1)
})

test('a follow-up message to the same child reuses the open implicit job', () => {
  const { engine, collector } = makeEngine()
  engine.declare({
    agent: 'team:solo2',
    capability: 'code.solo2',
    statement: 'do the delegated task and report the result',
  })
  const teams = {
    listMembers: () => [{ id: 'solo2-session', name: 'solo2', status: 'running' }],
    sendMessage: async () => ({}),
    spawnTeammate: async () => ({}),
  }
  const first = engine.bindToolDelegation({
    toolName: 'spawn_teammate',
    args: { name: 'solo2', prompt: 'first task' },
    value: { member: { target: 'solo2', status: 'running' } },
    callerSessionId: SESSION.id,
    callerAgent: { session: SESSION },
    teams,
  })
  assert.ok(first)
  const second = engine.bindToolDelegation({
    toolName: 'send_message',
    args: { target: 'solo2', message: 'one more detail' },
    value: {},
    callerSessionId: SESSION.id,
    callerAgent: { session: SESSION },
    teams,
  })
  assert.equal(second, first)
  assert.equal(engine.state.jobs.size, 1)
  assert.equal(engine.state.jobs.get(first).delegation.sessionId, 'solo2-session')
  for (const timer of engine.watchers.values()) clearInterval(timer)
  engine.watchers.clear()
})

test('spawn_teammate stays unbound when the agent has several promises', () => {
  const { engine } = makeEngine()
  engine.declare({ agent: 'team:multi', capability: 'code.one', statement: 'first capability of this agent' })
  engine.declare({ agent: 'team:multi', capability: 'code.two', statement: 'second capability of this agent' })
  const teams = { listMembers: () => [{ id: 'multi-session', name: 'multi', status: 'running' }], spawnTeammate: async () => ({}) }
  const bound = engine.bindToolDelegation({
    toolName: 'spawn_teammate',
    args: { name: 'multi', prompt: 'do it' },
    value: { member: { target: 'multi', status: 'running' } },
    callerSessionId: SESSION.id,
    callerAgent: { session: SESSION },
    teams,
  })
  assert.equal(bound, null)
  assert.equal(engine.state.jobs.size, 0)
})
