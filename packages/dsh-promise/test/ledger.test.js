import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Ledger } from '../src/ledger.js'
import { recordKey } from '../src/trust.js'
import { tempDir } from './helpers.js'

function promise(id, agent = 'preset:a', capability = 'code.change') {
  return { id, agent, capability, statement: 's', qos: {}, rules: [], assessment: {}, signals: {}, status: 'active', version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
}

function assessmentEvent(id, { agent = 'preset:a', capability = 'code.change', assessor = 'judge:jev', score = 1, weight = 0.7, at = Date.now() } = {}) {
  const assessment = {
    id, jobId: 'job', promiseId: 'p1', agent, capability, assessor, method: 'jev', level: 2,
    verdict: 'fulfilled', layers: {}, confidence: 0.8, failureMode: 'none', rationale: 'r', evidence: {}, createdAt: new Date().toISOString(),
  }
  return { type: 'assessment/recorded', payload: { assessment, evidence: [{ agent, capability, assessor, score, weight, at }] } }
}

test('append and reload reproduce the same state', () => {
  const dir = tempDir()
  const ledger = new Ledger({ dir, snapshotEvery: 100, prior: 0.5, halfLifeDays: 14 }).open()
  ledger.append('promise/declared', { promise: promise('p1') })
  ledger.append('job/opened', { job: { id: 'j1', promiseId: 'p1', agent: 'preset:a', capability: 'code.change', openedAt: new Date().toISOString() } })
  const event = assessmentEvent('a1')
  ledger.append(event.type, event.payload)
  ledger.append('job/closed', { jobId: 'j1', outcome: 'success', verdict: 'fulfilled' })
  const before = ledger.state.trust.get(recordKey('preset:a', 'code.change', 'judge:jev'))
  assert.ok(before)
  assert.equal(ledger.verifyChain().ok, true)

  const reloaded = new Ledger({ dir, snapshotEvery: 100, prior: 0.5, halfLifeDays: 14 }).open()
  const after = reloaded.state.trust.get(recordKey('preset:a', 'code.change', 'judge:jev'))
  assert.ok(Math.abs(after.score - before.score) < 1e-12)
  assert.equal(reloaded.state.jobs.get('j1').closedAt !== undefined, true)
  assert.equal(reloaded.lastSeq, ledger.lastSeq)
})

test('snapshot plus tail equals a full replay', () => {
  const dirA = tempDir()
  const dirB = tempDir()
  const snap = new Ledger({ dir: dirA, snapshotEvery: 2, prior: 0.5, halfLifeDays: 14 }).open()
  const full = new Ledger({ dir: dirB, snapshotEvery: 1_000, prior: 0.5, halfLifeDays: 14 }).open()
  for (let i = 0; i < 6; i += 1) {
    snap.append('promise/declared', { promise: promise(`p${i}`) })
    full.append('promise/declared', { promise: promise(`p${i}`) })
    const event = assessmentEvent(`a${i}`, { at: Date.now() + i })
    snap.append(event.type, event.payload)
    full.append(event.type, event.payload)
  }
  assert.ok(fs.existsSync(path.join(dirA, 'snapshot.json')))
  const reloaded = new Ledger({ dir: dirA, snapshotEvery: 2, prior: 0.5, halfLifeDays: 14 }).open()
  assert.equal(reloaded.state.promises.size, full.state.promises.size)
  assert.equal(reloaded.state.trust.get(recordKey('preset:a', 'code.change', 'judge:jev')).score,
    full.state.trust.get(recordKey('preset:a', 'code.change', 'judge:jev')).score)
})

test('a tampered ledger becomes read-only instead of silently trusting it', () => {
  const dir = tempDir()
  const ledger = new Ledger({ dir, snapshotEvery: 1_000, prior: 0.5, halfLifeDays: 14 }).open()
  ledger.append('promise/declared', { promise: promise('p1') })
  ledger.append('promise/declared', { promise: promise('p2') })
  const file = path.join(dir, 'ledger.jsonl')
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const tampered = JSON.parse(lines[0])
  tampered.payload.promise.statement = 'forged'
  lines[0] = JSON.stringify(tampered)
  fs.writeFileSync(file, `${lines.join('\n')}\n`)

  const reopened = new Ledger({ dir, snapshotEvery: 1_000, prior: 0.5, halfLifeDays: 14 }).open()
  assert.equal(reopened.readonly, true)
  assert.throws(() => reopened.append('promise/declared', { promise: promise('p3') }), /read-only/)
})

test('trust is a deterministic fold of evidence', () => {
  const dir = tempDir()
  const ledger = new Ledger({ dir, snapshotEvery: 1_000, prior: 0.5, halfLifeDays: 14 }).open()
  const at = Date.now()
  for (let i = 0; i < 5; i += 1) {
    const event = assessmentEvent(`a${i}`, { score: i % 2 === 0 ? 1 : 0.2, at: at + i * 1000 })
    ledger.append(event.type, event.payload)
  }
  const record = ledger.state.trust.get(recordKey('preset:a', 'code.change', 'judge:jev'))
  const replay = new Ledger({ dir: tempDir(), snapshotEvery: 1_000, prior: 0.5, halfLifeDays: 14 }).open()
  for (let i = 0; i < 5; i += 1) {
    const event = assessmentEvent(`a${i}`, { score: i % 2 === 0 ? 1 : 0.2, at: at + i * 1000 })
    replay.append(event.type, event.payload)
  }
  const other = replay.state.trust.get(recordKey('preset:a', 'code.change', 'judge:jev'))
  assert.equal(record.score, other.score)
  assert.equal(record.mass, other.mass)
})
