/**
 * Shared test helpers: temporary ledgers, a deterministic fake Jev, and an
 * engine factory. Nothing here touches the network or the real harness.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Config } from '../src/config.js'
import { Ledger } from '../src/ledger.js'
import { SessionCollector } from '../src/collector.js'
import { PromiseEngine } from '../src/engine.js'

export function tempDir(prefix = 'dsh-promise-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function makeConfig(overrides = {}) {
  return Config(overrides)
}

export function makeJev({ answers, delay = 0 } = {}) {
  const defaultAnswers = {
    addresses_request: { type: 'noul', noul: 0.9 },
    claims_contradicted: { type: 'noul', noul: 0.05 },
    absolute_quality: { type: 'score', score: 3.4, confidence: 0.6 },
    input_quality: { type: 'score', score: 3.2, confidence: 0.6 },
    process_quality: { type: 'score', score: 3.0, confidence: 0.6 },
    failure_mode: { type: 'choice', choice: 'none', confidence: 0.7 },
    unmet_requirement: { type: 'choice', choice: 'none', confidence: 0.8 },
  }
  const calls = []
  return {
    configured: true,
    model: 'jev-test',
    calls,
    async ask(state, questions) {
      calls.push({ state, questions })
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      return { model: 'jev-test', answers: answers ?? defaultAnswers, usage: { input_tokens: 10, output_tokens: 5 } }
    },
  }
}

/**
 * @param {object} [options]
 * @param {object} [options.config] overrides merged into the plugin config
 * @param {object|null} [options.jev] fake assessor
 */
export function makeEngine(options = {}) {
  const dir = options.dir ?? tempDir()
  const config = makeConfig(options.config ?? {})
  const ledger = new Ledger({
    dir,
    snapshotEvery: options.snapshotEvery ?? 50,
    prior: config.trust.prior,
    halfLifeDays: config.trust.halfLifeDays,
    logger: () => {},
  }).open()
  const collector = new SessionCollector()
  const engine = new PromiseEngine({
    config,
    ledger,
    collector,
    jev: options.jev ?? null,
    logger: options.logger ?? (() => {}),
  })
  return { engine, ledger, collector, config, dir }
}

export const SESSION = { id: 'session-test', header: { cwd: process.cwd() } }

/** Feed a synthetic turn into the collector. */
export function feedTurn(collector, session, { turn = 1, tools = [], assistant = 'done' } = {}) {
  collector.observe(session, { type: 'turn/start', data: { turn } })
  tools.forEach((tool, index) => {
    const callId = `call-${turn}-${index}`
    collector.observe(session, {
      type: 'tool/call',
      data: { turn, step: 1, callId, name: tool.name, arguments: JSON.stringify(tool.args ?? {}) },
    })
    collector.observe(session, {
      type: 'tool/result',
      data: {
        turn,
        step: 1,
        message: { toolCallId: callId, isError: tool.ok === false, content: [{ type: 'text', text: tool.text ?? 'ok' }] },
      },
    })
  })
  collector.observe(session, {
    type: 'assistant/message',
    data: { turn, step: 1, message: { id: `msg-${turn}`, role: 'assistant', content: [{ type: 'text', text: assistant }] } },
  })
  collector.observe(session, { type: 'turn/end', data: { turn } })
}

export function declareDev(engine, overrides = {}) {
  return engine.declare({
    agent: 'preset:developer',
    capability: 'code.change',
    statement: 'deliver a minimal diff that stays in scope and passes its checks',
    qos: { requiredFormat: 'diff' },
    rules: [
      { id: 'scope', kind: 'files-within', globs: ['src/**', 'test/**'] },
      { id: 'secrets', kind: 'no-match', pattern: 'sk-[A-Za-z0-9]{16,}' },
    ],
    requirements: [
      { id: 'fix', text: 'the requested behavior is implemented' },
    ],
    assessment: { policy: 'L2' },
    ...overrides,
  })
}
