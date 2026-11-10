/**
 * Session event collector: turns session facts (tool calls, results, assistant
 * text, feedback) into bounded observations for assessment. It never writes to
 * the session and never blocks the agent loop.
 * @module dsh-promise/collector
 */
import { blocksToText, sha256, truncateMiddle } from './util.js'
import { buildPolicy } from './policy.js'

const FILE_TOOLS = new Set(['write', 'edit', 'move', 'delete', 'create', 'patch', 'apply_patch'])

function sessionIdOf(session) {
  return String(session?.id ?? session?.sessionId ?? 'unknown')
}

function filePathsFrom(name, args) {
  const paths = []
  if (!args || typeof args !== 'object') return paths
  if (typeof args.path === 'string') paths.push(args.path)
  if (typeof args.file_path === 'string') paths.push(args.file_path)
  if (typeof args.filePath === 'string') paths.push(args.filePath)
  if (typeof args.source === 'string') paths.push(args.source)
  if (typeof args.destination === 'string') paths.push(args.destination)
  if (typeof args.target === 'string') paths.push(args.target)
  return FILE_TOOLS.has(name) ? paths : []
}

export class SessionCollector {
  /**
   * @param {object} [options]
   * @param {number} [options.maxTurns]
   * @param {number} [options.maxResultsPerTurn]
   * @param {(level:string, message:string)=>void} [options.logger]
   */
  constructor(options = {}) {
    this.maxTurns = options.maxTurns ?? 30
    this.maxResultsPerTurn = options.maxResultsPerTurn ?? 200
    this.log = options.logger ?? (() => {})
    this.sessions = new Map()
  }

  #state(sessionId) {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = {
        currentTurn: 0,
        turns: new Map(),
        files: new Set(),
        messageTurns: new Map(),
        policy: {},
        lastAt: Date.now(),
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  #turn(state, turn) {
    const key = Number.isFinite(turn) ? turn : state.currentTurn
    let entry = state.turns.get(key)
    if (!entry) {
      entry = { turn: key, startAt: Date.now(), endAt: null, calls: new Map(), results: [], assistants: [], feedback: [], files: new Set() }
      state.turns.set(key, entry)
      while (state.turns.size > this.maxTurns) {
        const oldest = state.turns.keys().next().value
        state.turns.delete(oldest)
      }
    }
    return entry
  }

  observe(session, event) {
    if (!event || typeof event !== 'object') return
    const sessionId = sessionIdOf(session)
    const state = this.#state(sessionId)
    const data = event.data ?? {}
    const at = Date.now()
    state.lastAt = at
    if (typeof session?.header?.agentPreset === 'string' && !state.policy.agentPreset) {
      state.policy.agentPreset = session.header.agentPreset
    }

    switch (event.type) {
      case 'subagent/descriptor': {
        if (typeof data.agentProvider === 'string') state.policy.provider = data.agentProvider
        if (typeof data.agentModel === 'string') state.policy.model = data.agentModel
        if (typeof data.agentReasoningEffort === 'string') state.policy.reasoningEffort = data.agentReasoningEffort
        break
      }
      case 'request/header': {
        const config = data.header?.config
        if (config) {
          if (typeof config.provider === 'string') state.policy.provider = config.provider
          if (typeof config.model === 'string') state.policy.model = config.model
          if (typeof config.reasoningEffort === 'string') state.policy.reasoningEffort = config.reasoningEffort
        }
        const tools = data.header?.tools
        if (Array.isArray(tools)) {
          const names = tools.map((tool) => tool?.name).filter((name) => typeof name === 'string').sort()
          state.policy.toolsHash = sha256(names.join('\n')).slice(0, 12)
        }
        break
      }
      case 'system/message': {
        if (!state.policy.systemPromptHash) {
          const text = blocksToText(data.message?.content, 1_000_000)
          if (text.length > 0) state.policy.systemPromptHash = sha256(text).slice(0, 12)
        }
        break
      }
      case 'turn/start': {
        state.currentTurn = data.turn ?? state.currentTurn
        const entry = this.#turn(state, state.currentTurn)
        entry.startAt = at
        break
      }
      case 'turn/end': {
        const entry = this.#turn(state, data.turn ?? state.currentTurn)
        entry.endAt = at
        break
      }
      case 'tool/call': {
        const entry = this.#turn(state, data.turn)
        let args = null
        try {
          args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments
        } catch {
          args = null
        }
        if (data.callId) entry.calls.set(String(data.callId), { callId: String(data.callId), name: data.name, args, at })
        for (const file of filePathsFrom(data.name, args)) {
          entry.files.add(file)
          state.files.add(file)
        }
        break
      }
      case 'tool/result': {
        const entry = this.#turn(state, data.turn)
        const message = data.message ?? {}
        const callId = message.toolCallId ? String(message.toolCallId) : undefined
        const call = callId ? entry.calls.get(callId) : undefined
        const result = {
          callId,
          name: call?.name ?? 'tool',
          ok: message.isError !== true,
          ms: call ? Math.max(0, at - call.at) : null,
          text: truncateMiddle(blocksToText(message.content, 4096), 2048),
        }
        entry.results.push(result)
        while (entry.results.length > this.maxResultsPerTurn) entry.results.shift()
        break
      }
      case 'assistant/message': {
        const entry = this.#turn(state, data.turn)
        const message = data.message ?? {}
        const text = blocksToText(message.content, 16_384)
        entry.assistants.push({ text, at })
        if (message.id) state.messageTurns.set(String(message.id), data.turn ?? state.currentTurn)
        const source = message.source
        if (source) {
          if (typeof source.provider === 'string' && !state.policy.provider) state.policy.provider = source.provider
          if (typeof source.model === 'string' && !state.policy.model) state.policy.model = source.model
        }
        break
      }
      case 'feedback/message-put': {
        const item = data.item ?? {}
        const messageId = item.messageId ? String(item.messageId) : undefined
        const turn = messageId ? state.messageTurns.get(messageId) : undefined
        const entry = this.#turn(state, turn ?? state.currentTurn)
        entry.feedback.push({
          messageId,
          rating: item.rating,
          note: item.note ?? null,
          category: item.category ?? null,
          at,
        })
        break
      }
      default:
        break
    }
  }

  lastTurn(sessionId) {
    const state = this.sessions.get(sessionId)
    if (!state) return 0
    return state.currentTurn
  }

  messageTurn(sessionId, messageId) {
    return this.sessions.get(sessionId)?.messageTurns.get(String(messageId))
  }

  /** Tools observed in one turn, used for signal-based attribution. */
  toolsInTurn(sessionId, turn) {
    const entry = this.sessions.get(sessionId)?.turns.get(turn)
    if (!entry) return []
    return [...new Set(entry.results.map((result) => result.name))]
  }

  /**
   * Build an observation for one turn (or the latest turn).
   * @param {string} sessionId
   * @param {{turn?:number, now?:number}} [options]
   */
  observationFor(sessionId, options = {}) {
    const state = this.sessions.get(sessionId)
    if (!state) {
      return { sessionId, turn: options.turn ?? 0, changedFiles: [], toolResults: [], outputText: '', durationMs: 0, retries: 0, feedback: [] }
    }
    const turn = options.turn ?? state.currentTurn
    const entry = state.turns.get(turn) ?? state.turns.get(state.currentTurn)
    const now = options.now ?? Date.now()
    const results = entry?.results ?? []
    let retries = 0
    const seenFailure = new Set()
    for (const result of results) {
      if (result.ok === false) seenFailure.add(result.name)
      else if (seenFailure.has(result.name)) {
        retries += 1
        seenFailure.delete(result.name)
      }
    }
    return {
      sessionId,
      turn,
      changedFiles: [...(entry?.files ?? state.files)],
      toolResults: results,
      outputText: (entry?.assistants ?? []).map((assistant) => assistant.text).join('\n'),
      durationMs: entry ? Math.max(0, (entry.endAt ?? now) - entry.startAt) : 0,
      retries,
      feedback: entry?.feedback ?? [],
    }
  }

  /**
   * Policy snapshot captured from the child/parent session's own events. The
   * task prompt is never hashed; `contractHash` comes from the promise record.
   * @param {string} sessionId
   * @param {{contractHash?:string}} [options]
   * @returns {object}
   */
  policyOf(sessionId, options = {}) {
    const state = this.sessions.get(String(sessionId))
    return buildPolicy({ ...(state?.policy ?? {}), contractHash: options.contractHash })
  }

  reset(sessionId) {
    this.sessions.delete(sessionId)
  }
}
