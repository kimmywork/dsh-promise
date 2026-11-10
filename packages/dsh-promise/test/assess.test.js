import test from 'node:test'
import assert from 'node:assert/strict'
import { buildQuestions, buildState, mapAnswers, runSemantic } from '../src/assess.js'
import { JevOversizeError } from '../src/jev.js'

const promise = {
  agent: 'preset:developer',
  capability: 'code.change',
  statement: 'deliver the requested change',
  qos: { requiredFormat: 'diff' },
  requirements: [{ id: 'fix', text: 'the requested behavior is implemented' }],
}

const job = { request: 'fix the bug', constraints: {} }
const observation = { rules: [], checks: [], toolResults: [], durationMs: 1000 }

test('questions are atomic and include requirement-level attribution', () => {
  const questions = buildQuestions(promise)
  assert.equal(questions.addresses_request.type, 'noul')
  assert.equal(questions.claims_contradicted.type, 'noul')
  assert.equal(questions.absolute_quality.type, 'score')
  assert.equal(questions.unmet_requirement.criteria.fix, 'the requested behavior is implemented')
  assert.equal(buildQuestions({ ...promise, requirements: [] }).unmet_requirement, undefined)
})

test('answers are mapped into 0..1 layers', () => {
  const mapped = mapAnswers({
    addresses_request: { noul: 0.9 },
    claims_contradicted: { noul: 0.1 },
    absolute_quality: { score: 3.2, confidence: 0.5 },
    input_quality: { score: 2.8, confidence: 0.6 },
    process_quality: { score: 4, confidence: 0.7 },
    failure_mode: { choice: 'none', confidence: 0.8 },
    unmet_requirement: { choice: 'none', confidence: 0.9 },
  })
  assert.equal(mapped.absolute, 0.8)
  assert.equal(mapped.process, 1)
  assert.equal(mapped.addressesRequest, 0.9)
  assert.ok(mapped.confidence > 0.5 && mapped.confidence < 0.8)
})

test('an oversized state is truncated to the byte budget', () => {
  const built = buildState({
    promise,
    job,
    observation,
    output: { text: 'x'.repeat(40_000) },
    maxBytes: 4_096,
  })
  assert.equal(built.truncated, true)
  assert.ok(built.bytes <= 4_096)
  assert.ok(Buffer.byteLength(built.state.output.text, 'utf8') < 4_096)
})

test('redaction runs before the state leaves the process', () => {
  const built = buildState({
    promise,
    job: { request: 'token sk-abcdefghijklmnop123', constraints: {} },
    observation,
    output: { text: 'sk-abcdefghijklmnop123' },
    maxBytes: 8_192,
    redactText: (value) => value.replace(/sk-[A-Za-z0-9]{16,}/g, '[REDACTED]'),
  })
  assert.ok(!JSON.stringify(built.state).includes('sk-abcdefghijklmnop123'))
})

test('boundary answers are resampled and averaged', async () => {
  let call = 0
  const client = {
    model: 'mock',
    async ask() {
      call += 1
      const noul = call === 1 ? 0.6 : 0.9
      return {
        model: 'mock',
        answers: {
          addresses_request: { type: 'noul', noul },
          claims_contradicted: { type: 'noul', noul: 0.05 },
          absolute_quality: { type: 'score', score: 3, confidence: 0.5 },
          input_quality: { type: 'score', score: 3, confidence: 0.5 },
          process_quality: { type: 'score', score: 3, confidence: 0.5 },
          failure_mode: { type: 'choice', choice: 'none', confidence: 0.5 },
          unmet_requirement: { type: 'choice', choice: 'none', confidence: 0.5 },
        },
        usage: null,
      }
    },
  }
  const result = await runSemantic({
    client,
    promise,
    job,
    observation,
    output: { text: 'diff' },
    config: { maxStateBytes: 8_192, resample: true, passThreshold: 0.7, failThreshold: 0.3, boundaryHigh: 0.85 },
  })
  assert.equal(result.meta.samples, 2)
  assert.ok(Math.abs(result.semantic.addressesRequest - 0.75) < 1e-9)
  assert.equal(result.semantic.unstable, true)
})

test('an oversize response triggers a truncate-and-retry', async () => {
  let calls = 0
  const sizes = []
  const client = {
    model: 'mock',
    async ask(state) {
      calls += 1
      sizes.push(Buffer.byteLength(JSON.stringify(state), 'utf8'))
      if (calls === 1) throw new JevOversizeError()
      return {
        model: 'mock',
        answers: {
          addresses_request: { type: 'noul', noul: 0.95 },
          claims_contradicted: { type: 'noul', noul: 0.02 },
          absolute_quality: { type: 'score', score: 3, confidence: 0.5 },
          input_quality: { type: 'score', score: 3, confidence: 0.5 },
          process_quality: { type: 'score', score: 3, confidence: 0.5 },
          failure_mode: { type: 'choice', choice: 'none', confidence: 0.5 },
        },
        usage: null,
      }
    },
  }
  const result = await runSemantic({
    client,
    promise,
    job,
    observation,
    output: { text: 'x'.repeat(50_000) },
    config: { maxStateBytes: 32_000, truncateToBytes: 2_048, resample: false },
  })
  assert.equal(calls, 2)
  assert.ok(sizes[1] < sizes[0])
  assert.equal(result.semantic.truncated, true)
  assert.equal(result.semantic.addressesRequest, 0.95)
})
