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
import { blocksToText } from './util.js'
import { buildSnapshot } from './inventory.js'

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

  // Optional services: the plugin still works without Agent Teams or subagents.
  const services = {
    getTeams: () => ctx.get('agentTeams'),
    getSubagents: () => ctx.get('subagents'),
    readSession: (sessionId) => {
      try {
        const session = ctx.sessions.get(sessionId)
        if (!session) return null
        const messages = session.deriveMessages()
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index]
          if (message?.role === 'assistant') return { outputText: blocksToText(message.content, 32_768) }
        }
      } catch (error) {
        log('warn', `reading delegated session failed: ${error?.message ?? error}`)
      }
      return null
    },
  }

  const engine = new PromiseEngine({ config, ledger, collector, jev, logger: log, services })

  for (const tool of buildTools(engine, collector, log, services)) {
    ctx.tools.register(tool)
  }

  // Read-only inventory for the client Promise panel. The Typert artifact is
  // generated in the upstream monorepo; here the service is marked at runtime
  // and the client falls back to hiding the panel if the namespace is absent.
  // Both the import and the registration are best-effort: a profile without the
  // Typert protocol must still boot the rest of the plugin.
  async function registerInventoryGateway() {
    let Remote
    let TypertRemoteService
    try {
      ({ Remote, TypertRemoteService } = await import('@deepseek-ai/dsh-typert-protocol'))
    } catch (error) {
      log('warn', `promiseInventory gateway unavailable: ${error?.message ?? error}`)
      return
    }
    try {
      class PromiseInventoryGateway extends TypertRemoteService {
        constructor(gatewayCtx) {
          super(gatewayCtx, 'promiseInventory')
        }

        async snapshot(sessionId) {
          let memberById
          try {
            const teams = services.getTeams()
            const agent = ctx.get('agents')?.get(String(sessionId))
            if (teams && agent) {
              memberById = (childId) => teams.listMembers(agent).find((member) => String(member.id) === String(childId))
            }
          } catch {
            // Roster unavailable: rows still come from the ledger.
          }
          return buildSnapshot({ engine, sessionId: String(sessionId), memberById })
        }
      }
      const initializers = []
      Remote('snapshot')(PromiseInventoryGateway.prototype.snapshot, {
        kind: 'method',
        name: 'snapshot',
        static: false,
        private: false,
        metadata: {},
        addInitializer(initializer) {
          initializers.push(initializer)
        },
      })
      for (const initialize of initializers) initialize.call(Object.create(PromiseInventoryGateway.prototype))
      await ctx.plugin(PromiseInventoryGateway)
    } catch (error) {
      log('warn', `promiseInventory gateway unavailable: ${error?.message ?? error}`)
    }
  }

  void registerInventoryGateway()

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
          .onSessionTurnEnd(sessionId, turn)
          .catch((error) => log('warn', `delegated settle failed: ${error?.message ?? error}`))
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

  // A subagent run reports its terminal identity independently of session delivery;
  // settle the linked job from that signal.
  ctx.on('subagent/end', (info) => {
    try {
      const jobId = info?.id === undefined ? undefined : engine.delegationBySession.get(String(info.id))
      if (jobId) void engine.settleDelegated(jobId).catch((error) => log('warn', `subagent settle failed: ${error?.message ?? error}`))
    } catch (error) {
      log('warn', `subagent end handling failed: ${error?.message ?? error}`)
    }
  })

  // The model may delegate with its own tools (spawn_teammate/send_message/subagent).
  // Post-execute carries the canonical result, including the child identity, so an
  // open job opened by promise_select can be bound to that child without a new tool.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    // Bind only after the waterfall accepts the call: a delegation that a later
    // policy blocks must not leave a linked job waiting on a child that never ran.
    const decision = await next()
    if (decision?.kind !== 'accept') return decision

    let boundJobId = null
    const finalValue = Object.hasOwn(decision, 'value') ? decision.value : result?.value
    try {
      if (result && result.isError === false) {
        const sessionId = exec?.agent?.session?.id
        boundJobId = engine.bindToolDelegation({
          toolName: exec?.name,
          args: exec?.arguments ?? {},
          value: finalValue,
          callerSessionId: sessionId ? String(sessionId) : undefined,
          callerAgent: exec?.agent,
          teams: services.getTeams(),
        })
      }
    } catch (error) {
      log('warn', `delegation binding failed: ${error?.message ?? error}`)
    }
    if (!boundJobId || config.ui?.annotateDelegation === false) return decision
    if (decision.content !== undefined || decision.value !== undefined) return decision
    try {
      const job = engine.state.jobs.get(boundJobId)
      if (!job) return decision
      const line = `↳ promise ${job.capability} · job ${boundJobId} · L${job.level} — bound automatically; settlement will be recorded`
      return { ...decision, content: [...(result.content ?? []), { type: 'text', text: line }] }
    } catch (error) {
      log('warn', `delegation annotation failed: ${error?.message ?? error}`)
      return decision
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
