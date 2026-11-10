/**
 * dsh-promise: Promise Theory trust, assessment and routing for DeepSeek Harness.
 *
 * The plugin is deliberately thin at the edges: five tools, one static prompt
 * section, one session listener. All policy lives in the engine and every state
 * change is a ledger event.
 * @module dsh-promise
 */
import os from 'node:os'
import path from 'node:path'
import { Config } from './config.js'
import { Ledger } from './ledger.js'
import { SessionCollector } from './collector.js'
import { JevClient } from './jev.js'
import { PromiseEngine } from './engine.js'
import { buildTools } from './tools.js'
import { PROTOCOL_TEXT } from './prompt.js'

export { Config }

export const name = 'promise'
export const inject = ['tools', 'systemPrompt', 'sessions']

function resolveDataDir(config) {
  if (config.dataDir) return config.dataDir
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'promise')
}

function makeLogger(ctx) {
  let scoped = null
  try {
    scoped = typeof ctx.logger === 'function' ? ctx.logger('dsh-promise') : ctx.logger ?? null
  } catch {
    scoped = null
  }
  return (level, message) => {
    const method = scoped?.[level]
    if (typeof method === 'function') {
      try {
        method.call(scoped, message)
        return
      } catch {
        // fall through to console
      }
    }
    if (level === 'warn' || level === 'error') console.warn(`[dsh-promise] ${message}`)
  }
}

export function apply(ctx, config) {
  if (!config?.enabled) return
  const log = makeLogger(ctx)
  const dataDir = resolveDataDir(config)

  const ledger = new Ledger({
    dir: dataDir,
    snapshotEvery: config.ledger.snapshotEvery,
    prior: config.trust.prior,
    halfLifeDays: config.trust.halfLifeDays,
    logger: log,
  }).open()

  if (ledger.readonly) {
    log('warn', `starting in read-only mode: ${ledger.readonlyReason}`)
  }

  const collector = new SessionCollector({ logger: log })
  // Volatile config values are wrappers; read them at use time so a settings
  // edit applies to the next call without a plugin remount.
  const readVolatile = (value) => (value && typeof value.get === 'function' ? value.get() : value)
  const envKey = process.env[config.jev.apiKeyEnv] ?? ''
  const jev = config.jev.enabled
    ? new JevClient({
      baseUrl: () => readVolatile(config.jev.baseUrl),
      apiKey: () => readVolatile(config.jev.apiKey) || envKey,
      model: () => readVolatile(config.jev.model),
      timeoutMs: config.jev.timeoutMs,
      logger: log,
    })
    : null
  const apiKey = jev?.apiKey ?? ''
  if (config.jev.enabled && !apiKey) {
    log('warn', `Jev is enabled but neither jev.apiKey nor ${config.jev.apiKeyEnv} is set; semantic assessment is unavailable and L1 still works`)
  }

  const engine = new PromiseEngine({ config, ledger, collector, jev, logger: log })

  for (const tool of buildTools(engine, collector, log)) {
    ctx.tools.register(tool)
  }

  ctx.systemPrompt.section({
    name: 'promise:protocol',
    order: 1200,
    text: () => (engine.state.promises.size > 0 ? PROTOCOL_TEXT : ''),
  })

  const seenTurns = new Set()
  ctx.on('session/event', (session, event) => {
    try {
      collector.observe(session, event)
      const sessionId = session?.id ? String(session.id) : undefined
      if (!sessionId) return
      if (event.type === 'turn/end') {
        const turn = event.data?.turn ?? 0
        const key = `${sessionId}:${turn}`
        if (seenTurns.has(key)) return
        seenTurns.add(key)
        if (seenTurns.size > 5_000) seenTurns.clear()
        void engine
          .autoSettle(sessionId, turn, { cwd: session?.header?.cwd })
          .catch((error) => log('warn', `auto settle failed: ${error?.message ?? error}`))
        return
      }
      if (event.type === 'feedback/message-put') {
        const item = event.data?.item
        if (!item?.messageId || !item?.rating) return
        engine.attachFeedback({
          sessionId,
          messageId: String(item.messageId),
          rating: item.rating,
          note: item.note ?? null,
        })
      }
    } catch (error) {
      log('warn', `session observation failed: ${error?.message ?? error}`)
    }
  })

  ctx.on('dispose', () => {
    try {
      if (!ledger.readonly) ledger.snapshot()
    } catch (error) {
      log('warn', `ledger snapshot on dispose failed: ${error?.message ?? error}`)
    }
  })
}
