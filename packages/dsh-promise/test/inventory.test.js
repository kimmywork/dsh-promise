import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSnapshot } from '../src/inventory.js'
import { declareDev, feedTurn, makeEngine, SESSION } from './helpers.js'

test('snapshot joins team and subagent jobs with trust and recent verdicts', async () => {
  const { engine, collector } = makeEngine()
  declareDev(engine, { agent: 'team:dev', capability: 'code.team' })
  declareDev(engine, { agent: 'preset:dev', capability: 'code.sub' })

  feedTurn(collector, SESSION, { turn: 1, tools: [{ name: 'edit', args: { path: 'src/a.js' } }], assistant: 'done' })
  const teamJob = engine.select({ capability: 'code.team', need: 'team work' }, { sessionId: SESSION.id, turn: 1 })
  await engine.settle({ jobId: teamJob.jobId, outcome: 'success', output: 'diff' }, { sessionId: SESSION.id, turn: 1 })
  engine.select({ capability: 'code.sub', need: 'sub work' }, { sessionId: SESSION.id, turn: 1 })

  const snapshot = buildSnapshot({ engine, sessionId: SESSION.id })
  assert.equal(snapshot.header.promises, 2)
  assert.equal(snapshot.header.assessed, 1)
  assert.equal(snapshot.recent.length, 1)
  assert.equal(snapshot.recent[0].verdict, 'fulfilled')

  const team = snapshot.rows.find((row) => row.capability === 'code.team')
  const sub = snapshot.rows.find((row) => row.capability === 'code.sub')
  assert.equal(team.kind, 'team')
  assert.equal(sub.kind, 'subagent')
  assert.ok(team.trust > 0.5)
  assert.equal(sub.evidence, 0)
  assert.equal(snapshot.header.credit, team.trust)
})
