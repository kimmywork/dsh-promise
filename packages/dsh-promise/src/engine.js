/**
 * The promise engine: declarations, routing, settlement, assessment, breach
 * policy and superagent composition. All side effects go through the ledger.
 * @module dsh-promise/engine
 */
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { newId, nowIso, parseMs, sha256, slug, truncateMiddle, matchGlobs } from './util.js'
import { trustView, effectiveN } from './trust.js'
import { planLevel, shouldSample } from './planner.js'
import { evaluateRules } from './rules.js'
import { rankCandidates } from './router.js'
import { decide, verdictScore } from './verdict.js'
import { runSemantic } from './assess.js'
import { JevOversizeError } from './jev.js'

const LEVEL_WEIGHT = { 0: 0, 1: 0.35, 2: 0.7, 3: 1 }
const CAPABILITY_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/
const AGENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{1,96}$/

export class PromiseEngine {
  /**
   * @param {object} options
   * @param {object} options.config normalized plugin config
   * @param {import('./ledger.js').Ledger} options.ledger
   * @param {import('./collector.js').SessionCollector} options.collector
   * @param {import('./jev.js').JevClient|null} options.jev
   * @param {(level:string, message:string)=>void} [options.logger]
   */
  constructor(options) {
    this.config = options.config
    this.ledger = options.ledger
    this.collector = options.collector
    this.jev = options.jev
    this.log = options.logger ?? (() => {})
    this.services = options.services ?? {}
    this.budget = new Map()
    this.delegations = new Map()
    this.delegationBySession = new Map()
    this.watchers = new Map()
    this.settling = new Set()
    // Rebuild links for jobs that survived a restart; completion signals can
    // still settle them even though the runtime handles are gone.
    for (const job of this.state.jobs.values()) {
      if (job.closedAt || !job.delegation?.sessionId) continue
      const link = { ...job.delegation, settled: false }
      this.delegations.set(job.id, link)
      this.delegationBySession.set(String(job.delegation.sessionId), job.id)
    }
  }

  get state() {
    return this.ledger.state
  }

  trustFor(agent, capability) {
    return trustView(this.state.trust, agent, capability, this.config.trust.prior, { now: Date.now(), halfLifeDays: this.config.trust.halfLifeDays })
  }

  promisesFor(capability) {
    return [...this.state.promises.values()].filter((promise) => promise.capability === capability)
  }

  findPromise(agent, capability) {
    return [...this.state.promises.values()].find((promise) => promise.agent === agent && promise.capability === capability)
  }

  #warn(message) {
    this.log('warn', message)
  }

  declare(input, { declaredBy = 'agent' } = {}) {
    const agent = String(input.agent ?? '').trim()
    const capability = String(input.capability ?? '').trim()
    if (!AGENT_RE.test(agent)) throw new Error('invalid agent id: expected preset:x, tool:x or compose:x')
    if (!CAPABILITY_RE.test(capability)) throw new Error('invalid capability: use dotted lowercase, e.g. code.change')
    if (!input.statement || String(input.statement).trim().length < 8) throw new Error('statement must be a falsifiable sentence (≥ 8 chars)')

    const existing = this.findPromise(agent, capability)
    const now = nowIso()
    const warnings = []
    const record = {
      id: existing?.id ?? newId('promise'),
      agent,
      capability,
      statement: String(input.statement).trim(),
      qos: normalizeQos(input.qos),
      requirements: normalizeRequirements(input.requirements),
      rules: Array.isArray(input.rules) ? input.rules : [],
      checks: normalizeChecks(input.checks, declaredBy),
      assessment: normalizeAssessment(input.assessment, this.config),
      signals: normalizeSignals(input.signals),
      status: input.status === 'active'
        ? 'active'
        : input.status === 'draft'
          ? 'draft'
          : existing?.status && existing.status !== 'retired'
            ? existing.status
            : 'active',
      version: (existing?.version ?? 0) + 1,
      declaredBy,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    if (record.checks.length > 0 && !this.config.checks.allowModelDeclared) {
      warnings.push('checks stay inert until checks.allowModelDeclared=true and the command matches checks.allowlist')
    }
    if (record.rules.length === 0 && record.checks.length === 0 && record.assessment.policy === 'L0') {
      warnings.push('promise has no rules, checks or semantic policy; trust will not accumulate')
    }
    this.ledger.append(existing ? 'promise/updated' : 'promise/declared', { promise: record })
    return { promise: record, warnings }
  }

  select(input, context = {}) {
    const capability = String(input.capability ?? '').trim()
    if (!CAPABILITY_RE.test(capability)) throw new Error('invalid capability')
    const need = String(input.need ?? '').trim()
    if (!need) throw new Error('need is required')

    const promises = this.promisesFor(capability)
    if (promises.length === 0) {
      return {
        jobId: '',
        recommended: null,
        candidates: [],
        level: 0,
        levelReasons: ['no promise declared for this capability'],
        guidance: `declare a promise first: promise_declare({agent, capability:"${capability}", statement, qos, assessment})`,
      }
    }

    const constraints = normalizeConstraints(input.constraints)
    const { candidates } = rankCandidates({
      promises,
      lookup: (agent, cap) => this.trustFor(agent, cap),
      constraints,
      weights: this.config.routing.weights,
      totalJobs: this.state.counters.jobs,
      explorationBonus: this.config.trust.explorationBonus,
      minEvidence: this.config.trust.minEvidence,
      probationFloor: this.config.trust.probationFloor,
    })

    if (candidates.length === 0) {
      return {
        jobId: '',
        recommended: null,
        candidates: [],
        level: 0,
        levelReasons: ['no eligible promise satisfies the hard constraints'],
        guidance: 'relax constraints (latency/format) or declare a promise that can meet them',
      }
    }

    const recommended = candidates[0]
    const view = this.trustFor(recommended.agent, capability)
    const planned = planLevel({
      riskTier: input.riskTier,
      reversible: input.reversible,
      value: input.value,
      mass: view.mass,
      declaredPolicy: recommended.assessment?.policy,
      budgetExhausted: this.#budgetExhausted(context.sessionId, context.turn),
      defaultLevel: this.config.assessment.defaultLevel,
    }, { coldStartMass: this.config.trust.coldStartMass, defaultLevel: this.config.assessment.defaultLevel })

    const job = {
      id: newId('job'),
      promiseId: recommended.promiseId,
      agent: recommended.agent,
      capability,
      request: truncateMiddle(need, 8_192),
      constraints,
      riskTier: Number.isInteger(input.riskTier) ? input.riskTier : null,
      reversible: input.reversible !== false,
      value: input.value ?? 'low',
      level: planned.level,
      levelReasons: planned.reasons,
      sessionId: context.sessionId ?? null,
      turn: context.turn ?? 0,
      attribution: 'explicit',
      outcome: null,
      openedAt: nowIso(),
      closedAt: null,
    }
    this.ledger.append('job/opened', { job })

    return {
      jobId: job.id,
      recommended,
      candidates: candidates.slice(0, 5),
      level: planned.level,
      levelReasons: planned.reasons,
      guidance: guidanceFor(recommended.invoke, job.id),
    }
  }

  async settle(input, context = {}) {
    const job = this.state.jobs.get(String(input.jobId ?? ''))
    if (!job) throw new Error(`unknown jobId: ${input.jobId}`)
    const promise = input.promiseId
      ? [...this.state.promises.values()].find((candidate) => candidate.id === input.promiseId)
      : [...this.state.promises.values()].find((candidate) => candidate.id === job.promiseId)
    if (!promise) throw new Error(`promise for job ${job.id} no longer exists`)

    if (job.closedAt) {
      if (job.closedBy === 'auto') return this.#enrich(job, promise, input, context)
      return { jobId: job.id, verdict: job.verdict, note: 'job already settled', level: job.level, closedAt: job.closedAt }
    }

    const sessionId = context.sessionId ?? job.sessionId
    const observation = context.observation ?? this.collector.observationFor(sessionId, { turn: job.turn })
    const outputText = String(input.output ?? observation.outputText ?? '')
    const latencyMs = Number(input.latencyMs ?? observation.durationMs ?? 0)
    const enrichedObservation = {
      ...observation,
      outputText,
      durationMs: latencyMs,
      checks: [],
    }

    const ruleResults = evaluateRules(promise, enrichedObservation)
    const checkResults = context.auto && !this.config.checks.runOnAuto ? [] : await this.#runChecks(promise, context.cwd)
    enrichedObservation.checks = checkResults

    const view = this.trustFor(promise.agent, promise.capability)
    const budgetExhausted = this.#budgetExhausted(sessionId, job.turn)
    const planned = planLevel({
      riskTier: job.riskTier,
      reversible: job.reversible,
      value: job.value,
      mass: view.mass,
      declaredPolicy: promise.assessment?.policy,
      budgetExhausted,
      defaultLevel: this.config.assessment.defaultLevel,
    }, { coldStartMass: this.config.trust.coldStartMass, defaultLevel: this.config.assessment.defaultLevel })

    let semantic = null
    let semanticMeta = null
    const semanticWanted = planned.level >= 2 && Boolean(this.jev?.configured) && !budgetExhausted
    const sampleRate = promise.assessment?.sampleRate ?? this.config.assessment.sampleRate
    const shouldAsk = planned.level >= 3 || (semanticWanted && shouldSample(sampleRate, context.random))
    if (semanticWanted && shouldAsk) {
      this.#spendBudget(sessionId, job.turn)
      try {
        const result = await runSemantic({
          client: this.jev,
          promise,
          job,
          observation: enrichedObservation,
          output: { text: outputText },
          config: { ...this.config.assessment, ...definedOnly(promise.assessment), passThreshold: this.#thresholds(promise).pass },
          redactText: (value) => this.#redact(value),
          signal: context.signal,
          logger: this.log,
        })
        semantic = result.semantic
        semanticMeta = result.meta
      } catch (error) {
        const code = error instanceof JevOversizeError ? 'oversize' : error?.code ?? 'error'
        this.#warn(`semantic assessment skipped (${code}): ${error?.message ?? error}`)
        semanticMeta = { skipped: true, code, message: String(error?.message ?? error) }
      }
    }

    const thresholds = this.#thresholds(promise)
    const layers = {
      absolute: semantic?.absolute,
      process: semantic?.process,
      relative: this.#relative(promise.capability, semantic),
      inputQuality: semantic?.inputQuality,
    }
    const verdict = decide({
      rules: [...ruleResults, ...checkResults.filter((check) => !check.skipped)],
      semantic,
      thresholds,
      truncated: semantic?.truncated === true,
    })

    const viewBefore = this.trustFor(promise.agent, promise.capability)
    const attributionWeight = job.attribution === 'signal' ? this.config.attribution.signalWeight : 1
    const assessor = semantic ? 'judge:jev' : 'system:checks'
    const evidence = []
    if (verdict.verdict !== 'undetermined') {
      evidence.push({
        agent: promise.agent,
        capability: promise.capability,
        assessor,
        score: verdictScore(verdict.verdict, layers),
        weight: LEVEL_WEIGHT[planned.level] * (0.5 + 0.5 * verdict.confidence) * attributionWeight,
        at: Date.now(),
      })
    }

    const assessment = {
      id: newId('assess'),
      jobId: job.id,
      promiseId: promise.id,
      agent: promise.agent,
      capability: promise.capability,
      assessor,
      method: semantic ? 'jev' : 'rules',
      level: planned.level,
      verdict: verdict.verdict,
      layers,
      confidence: verdict.confidence,
      failureMode: semantic?.failureMode ?? verdict.failureMode,
      unmetRequirement: semantic?.unmetRequirement ?? null,
      rationale: verdict.rationale,
      evidence: { outputHash: sha256(outputText), truncated: semantic?.truncated === true, rules: [...ruleResults, ...checkResults] },
      meta: semanticMeta,
      createdAt: nowIso(),
    }
    this.ledger.append('assessment/recorded', { assessment, evidence })

    let breach = null
    if (verdict.verdict === 'violated') breach = this.#applyBreach(promise, job, assessment, viewBefore)
    const recovery = this.#recover(promise, verdict.verdict)

    this.ledger.append('job/closed', {
      jobId: job.id,
      outcome: input.outcome === 'failure' ? 'failure' : 'success',
      latencyMs,
      closedAt: nowIso(),
      closedBy: context.closedBy ?? (context.auto ? 'auto' : 'settle'),
      verdict: verdict.verdict,
      assessmentId: assessment.id,
    })

    return {
      jobId: job.id,
      agent: promise.agent,
      capability: promise.capability,
      level: planned.level,
      levelReasons: planned.reasons,
      verdict: verdict.verdict,
      layers,
      confidence: Number(verdict.confidence.toFixed(3)),
      failureMode: assessment.failureMode,
      unmetRequirement: assessment.unmetRequirement,
      rationale: verdict.rationale,
      rules: [...ruleResults, ...checkResults],
      trust: this.#trustDelta(promise.agent, promise.capability, evidence[0], viewBefore),
      breach,
      recovery,
      semantic: semanticMeta,
    }
  }

  async #enrich(job, promise, input, context) {
    const already = [...this.state.assessments.values()].some(
      (assessment) => assessment.jobId === job.id && assessment.method === 'jev',
    )
    if (already) {
      return { jobId: job.id, verdict: job.verdict, note: 'job was already enriched; no second semantic assessment', level: job.level }
    }
    const outputText = String(input.output ?? '')
    if (!outputText || !this.jev?.configured) {
      return { jobId: job.id, verdict: job.verdict, note: 'job was auto-settled; no semantic enrichment applied', level: job.level }
    }
    const view = this.trustFor(promise.agent, promise.capability)
    const planned = planLevel({
      riskTier: job.riskTier,
      reversible: job.reversible,
      value: job.value,
      mass: view.mass,
      declaredPolicy: promise.assessment?.policy,
      budgetExhausted: this.#budgetExhausted(job.sessionId, job.turn),
      defaultLevel: this.config.assessment.defaultLevel,
    }, { coldStartMass: this.config.trust.coldStartMass, defaultLevel: this.config.assessment.defaultLevel })
    const semanticWanted = planned.level >= 2 && !this.#budgetExhausted(job.sessionId, job.turn)
    if (!semanticWanted) return { jobId: job.id, verdict: job.verdict, note: 'auto-settled at L1', level: planned.level }
    this.#spendBudget(job.sessionId, job.turn)
    try {
      const observation = this.collector.observationFor(job.sessionId, { turn: job.turn })
      const result = await runSemantic({
        client: this.jev,
        promise,
        job,
        observation: { ...observation, outputText, durationMs: observation.durationMs },
        output: { text: outputText },
        config: { ...this.config.assessment, ...definedOnly(promise.assessment) },
        redactText: (value) => this.#redact(value),
        signal: context.signal,
        logger: this.log,
      })
      const layers = {
        absolute: result.semantic.absolute,
        process: result.semantic.process,
        relative: this.#relative(promise.capability, result.semantic),
        inputQuality: result.semantic.inputQuality,
      }
      const verdict = decide({ rules: [], semantic: result.semantic, thresholds: this.#thresholds(promise) })
      const assessment = {
        id: newId('assess'),
        jobId: job.id,
        promiseId: promise.id,
        agent: promise.agent,
        capability: promise.capability,
        assessor: 'judge:jev',
        method: 'jev',
        level: planned.level,
        verdict: verdict.verdict,
        layers,
        confidence: verdict.confidence,
        failureMode: result.semantic.failureMode ?? verdict.failureMode,
        unmetRequirement: result.semantic.unmetRequirement ?? null,
        rationale: verdict.rationale,
        evidence: { outputHash: sha256(outputText), truncated: result.meta.truncated },
        meta: result.meta,
        createdAt: nowIso(),
      }
      const evidence = verdict.verdict === 'undetermined' ? [] : [{
        agent: promise.agent,
        capability: promise.capability,
        assessor: 'judge:jev',
        score: verdictScore(verdict.verdict, layers),
        weight: LEVEL_WEIGHT[planned.level] * (0.5 + 0.5 * verdict.confidence),
        at: Date.now(),
      }]
      const viewBefore = this.trustFor(promise.agent, promise.capability)
      this.ledger.append('assessment/recorded', { assessment, evidence })
      const breach = verdict.verdict === 'violated' ? this.#applyBreach(promise, job, assessment, viewBefore) : null
      return { jobId: job.id, verdict: verdict.verdict, layers, confidence: verdict.confidence, rationale: verdict.rationale, breach, note: 'semantic enrichment of an auto-settled job' }
    } catch (error) {
      this.#warn(`semantic enrichment failed: ${error?.message ?? error}`)
      return { jobId: job.id, verdict: job.verdict, note: 'enrichment failed; auto verdict kept' }
    }
  }

  async autoSettle(sessionId, turn, context = {}) {
    const jobs = [...this.state.jobs.values()].filter(
      (job) => job.sessionId === sessionId && job.turn === turn && !job.closedAt && !job.delegation,
    )
    for (const job of jobs) {
      await this.settle({ jobId: job.id, outcome: 'success' }, { ...context, sessionId, auto: true })
    }
    if (jobs.length > 0) return { settled: jobs.length }

    const tools = this.collector.toolsInTurn(sessionId, turn)
    if (tools.length === 0) return { settled: 0 }
    // Generic tools (read/grep/bash/edit) appear in ordinary turns, so signal
    // attribution is opt-in; otherwise a normal turn could be judged against a
    // promise it never attempted.
    const optedIn = [...this.state.promises.values()].filter(
      (promise) => promise.status === 'active' && promise.signals?.autoAttribute === true,
    )
    if (optedIn.length === 0) return { settled: 0 }
    const candidates = optedIn.filter((promise) => {
      const signals = promise.signals?.tool ?? []
      return signals.some((tool) => tools.includes(tool))
    })
    if (candidates.length !== 1) {
      this.ledger.append('observation/unattributed', { sessionId, turn, tools, candidates: candidates.length })
      return { settled: 0, unattributed: true, candidates: candidates.length }
    }
    const promise = candidates[0]
    const job = {
      id: newId('job'),
      promiseId: promise.id,
      agent: promise.agent,
      capability: promise.capability,
      request: '(auto-attributed turn)',
      constraints: {},
      riskTier: null,
      reversible: true,
      value: 'low',
      level: 1,
      levelReasons: ['auto-attributed by tool signal; L1 only'],
      sessionId,
      turn,
      attribution: 'signal',
      outcome: null,
      openedAt: nowIso(),
      closedAt: null,
    }
    this.ledger.append('job/opened', { job })
    try {
      await this.settle({ jobId: job.id, outcome: 'success' }, { ...context, sessionId, auto: true })
      return { settled: 1, autoAttributed: promise.id }
    } catch (error) {
      this.#warn(`auto settle failed: ${error?.message ?? error}`)
      return { settled: 0 }
    }
  }

  /**
   * Link an open job to a dispatched child (teammate session or subagent
   * session) so completion can settle it with the child's own output.
   */
  linkDelegation(jobId, delegation) {
    const job = this.state.jobs.get(jobId)
    if (!job) throw new Error(`unknown jobId: ${jobId}`)
    if (job.closedAt) throw new Error('job is already settled')
    const link = {
      ...delegation,
      sessionId: String(delegation.sessionId),
      startedAt: Date.now(),
      settled: false,
    }
    this.delegations.set(jobId, link)
    this.delegationBySession.set(link.sessionId, jobId)
    // Runtime-only handles (Agent, TeamService) must never enter the ledger.
    const persisted = { kind: link.kind, name: link.name, sessionId: link.sessionId, startedAt: link.startedAt }
    this.ledger.append('job/linked', { jobId, delegation: persisted })
    this.#watchDelegation(jobId)
    return link
  }

  #watchDelegation(jobId) {
    const link = this.delegations.get(jobId)
    if (!link || link.kind !== 'team' || !link.teams || !link.leadAgent) return
    const interval = this.services.watchIntervalMs ?? 1500
    const deadline = link.startedAt + (this.config.assessment.delegationTimeoutMs ?? 1_800_000)
    const timer = setInterval(() => {
      const current = this.delegations.get(jobId)
      if (!current || current.settled) {
        clearInterval(timer)
        this.watchers.delete(jobId)
        return
      }
      if (Date.now() > deadline) {
        clearInterval(timer)
        this.watchers.delete(jobId)
        this.#warn(`delegated job ${jobId} timed out waiting for the teammate`)
        return
      }
      try {
        const member = current.teams.listMembers(current.leadAgent).find((entry) => String(entry.id) === current.sessionId)
        if (!member) return
        if (member.status === 'running' || member.status === 'provisioning') return
        clearInterval(timer)
        this.watchers.delete(jobId)
        if (member.status === 'failed') {
          void this.settleDelegated(jobId, { error: `teammate ${current.name} failed` }).catch((error) => this.#warn(`delegated settle failed: ${error?.message ?? error}`))
          return
        }
        void this.settleDelegated(jobId).catch((error) => this.#warn(`delegated settle failed: ${error?.message ?? error}`))
      } catch (error) {
        this.#warn(`delegation watch failed: ${error?.message ?? error}`)
      }
    }, interval)
    timer.unref?.()
    this.watchers.set(jobId, timer)
  }

  /**
   * Settle a delegated job from the child's own session, once.
   * @param {string} jobId
   * @param {{output?: string, error?: string}} [options]
   */
  async settleDelegated(jobId, options = {}) {
    if (this.settling.has(jobId)) return null
    const job = this.state.jobs.get(jobId)
    if (!job || job.closedAt) return null
    const link = this.delegations.get(jobId) ?? job.delegation
    if (!link) return null
    this.settling.add(jobId)
    const timer = this.watchers.get(jobId)
    if (timer) {
      clearInterval(timer)
      this.watchers.delete(jobId)
    }
    const current = this.delegations.get(jobId)
    if (current) current.settled = true
    const sessionId = String(link.sessionId)
    const observation = this.collector.observationFor(sessionId)
    let outputText = options.output ?? observation.outputText ?? ''
    if (!outputText && this.services.readSession) {
      try {
        outputText = this.services.readSession(sessionId)?.outputText ?? ''
      } catch (error) {
        this.#warn(`reading delegated session failed: ${error?.message ?? error}`)
      }
    }
    try {
      return await this.settle(
        {
          jobId,
          outcome: options.error ? 'failure' : 'success',
          output: outputText,
          latencyMs: Date.now() - (link.startedAt ?? Date.now()),
        },
        { sessionId, observation, cwd: link.cwd, closedBy: 'delegated' },
      )
    } catch (error) {
      this.#warn(`delegated settle failed: ${error?.message ?? error}`)
      const retry = this.delegations.get(jobId)
      if (retry) retry.settled = false
      return null
    } finally {
      this.settling.delete(jobId)
    }
  }

  /**
   * Bind an open job to a delegation the model started itself (spawn_teammate,
   * send_message, subagent). The canonical tool result carries the child
   * identity, so no result parsing is needed.
   * @returns the bound job id, or null when nothing unambiguous matched
   */
  bindToolDelegation({ toolName, args = {}, value, callerSessionId, callerAgent, teams }) {
    if (!callerSessionId || value === undefined || value === null) return null
    const supported = new Set(['spawn_teammate', 'send_message', 'subagent', 'subagent_fork'])
    if (!supported.has(toolName)) return null
    const open = [...this.state.jobs.values()].filter(
      (job) => job.sessionId === callerSessionId && !job.closedAt && !job.delegation,
    )
    if (open.length === 0) return null

    let candidates = []
    let link = null
    if (toolName === 'spawn_teammate') {
      const name = typeof args.name === 'string' ? args.name : ''
      candidates = open.filter((job) => job.agent === `team:${name}`)
      const member = value?.member
      if (member?.id) {
        link = { kind: 'team', name: member.name ?? name, sessionId: String(member.id), leadAgent: callerAgent, teams }
      }
    } else if (toolName === 'send_message') {
      const target = typeof args.target === 'string' ? args.target : ''
      candidates = open.filter((job) => job.agent === `team:${target}`)
      if (teams && target && target !== 'lead') {
        try {
          const member = teams.listMembers(callerAgent).find((entry) => entry.name === target)
          if (member) {
            link = { kind: 'team', name: target, sessionId: String(member.id), leadAgent: callerAgent, teams }
          }
        } catch {
          // Roster unavailable: leave the job unlinked rather than guess.
        }
      }
    } else {
      const preset = typeof args.agent_preset === 'string' ? args.agent_preset : undefined
      candidates = open.filter(
        (job) => job.agent.startsWith('preset:') && (preset === undefined || job.agent === `preset:${preset}`),
      )
      const childId = value?.subagentId ?? value?.childId
      if (childId) link = { kind: 'subagent', name: preset ?? 'subagent', sessionId: String(childId) }
    }
    if (candidates.length !== 1 || !link) return null
    this.linkDelegation(candidates[0].id, link)
    return candidates[0].id
  }

  /** Called for every child-session turn end; settles a linked job when the child is done. */
  onSessionTurnEnd(sessionId, turn) {
    const jobId = this.delegationBySession.get(String(sessionId))
    if (!jobId) return Promise.resolve(null)
    const link = this.delegations.get(jobId)
    if (!link || link.settled) return Promise.resolve(null)
    if (link.kind === 'team' && link.teams && link.leadAgent) {
      try {
        const member = link.teams.listMembers(link.leadAgent).find((entry) => String(entry.id) === String(sessionId))
        if (member && (member.status === 'running' || member.status === 'provisioning')) return Promise.resolve(null)
      } catch {
        // Fall through: settle on the turn boundary if the roster is unavailable.
      }
    }
    return this.settleDelegated(jobId)
  }

  attachFeedback({ sessionId, messageId, rating, note = null }) {
    const turn = this.collector.messageTurn(sessionId, messageId)
    if (turn == null) return null
    const job = [...this.state.jobs.values()].find((candidate) => candidate.sessionId === sessionId && candidate.turn === turn)
    if (!job) return null
    const already = [...this.state.assessments.values()].some(
      (assessment) => assessment.jobId === job.id && assessment.sourceMessageId === String(messageId),
    )
    if (already) return null
    const positive = rating === 'positive'
    const assessment = {
      id: newId('assess'),
      jobId: job.id,
      promiseId: job.promiseId,
      agent: job.agent,
      capability: job.capability,
      assessor: 'user:feedback',
      method: 'user',
      level: 1,
      verdict: positive ? 'fulfilled' : 'violated',
      layers: {},
      confidence: 0.8,
      failureMode: positive ? 'none' : 'process',
      unmetRequirement: null,
      rationale: positive ? 'user rated the result positive' : `user rated the result negative${note ? `: ${note}` : ''}`,
      evidence: { feedback: true },
      meta: null,
      sourceMessageId: String(messageId),
      createdAt: nowIso(),
    }
    this.ledger.append('assessment/recorded', {
      assessment,
      evidence: [{
        agent: job.agent,
        capability: job.capability,
        assessor: 'user:feedback',
        score: positive ? 1 : 0.2,
        weight: 1,
        at: Date.now(),
      }],
    })
    return assessment
  }

  compose(input) {
    const name = String(input.name ?? '').trim()
    if (!name) throw new Error('composition name is required')
    const id = `compose:${slug(name)}`
    const external = input.external ?? {}
    const declared = this.declare({
      agent: id,
      capability: external.capability,
      statement: external.statement,
      qos: external.qos,
      assessment: external.assessment,
      rules: external.rules,
      requirements: external.requirements,
      signals: external.signals,
    }, { declaredBy: 'user' })
    const children = (Array.isArray(input.children) ? input.children : []).map((child, index) => ({
      agent: String(child.agent ?? ''),
      capability: String(child.capability ?? ''),
      weight: Number.isFinite(child.weight) ? child.weight : 1,
      order: index,
    }))
    const composition = {
      id,
      name,
      externalPromiseId: declared.promise.id,
      children,
      createdAt: nowIso(),
    }
    this.ledger.append('composition/declared', { composition })
    const health = this.#compositionHealth(children)
    return { composition, externalPromise: declared.promise, health, warnings: declared.warnings }
  }

  inspect(input = {}) {
    const what = input.what ?? 'summary'
    const limit = Math.max(1, Math.min(100, input.limit ?? 20))
    if (what === 'trust') {
      const rows = []
      for (const promise of this.state.promises.values()) {
        if (input.agent && promise.agent !== input.agent) continue
        if (input.capability && promise.capability !== input.capability) continue
        const view = this.trustFor(promise.agent, promise.capability)
        rows.push({ agent: promise.agent, capability: promise.capability, status: promise.status, ...view })
      }
      rows.sort((a, b) => b.score - a.score)
      return { what, rows: rows.slice(0, limit), text: renderTrust(rows.slice(0, limit)) }
    }
    if (what === 'promise') {
      const rows = [...this.state.promises.values()]
        .filter((promise) => (!input.agent || promise.agent === input.agent) && (!input.capability || promise.capability === input.capability))
        .slice(0, limit)
      return { what, rows, text: renderPromises(rows) }
    }
    if (what === 'ledger') {
      return { what, text: this.#renderLedger(limit) }
    }
    if (what === 'breach') {
      const rows = this.state.breaches.slice(-limit).reverse()
      return { what, rows, text: renderBreaches(rows) }
    }
    return { what: 'summary', text: this.#renderSummary() }
  }

  #renderSummary() {
    const promises = [...this.state.promises.values()]
    const jobs = [...this.state.jobs.values()]
    const assessments = [...this.state.assessments.values()]
    const byVerdict = { fulfilled: 0, violated: 0, undetermined: 0 }
    for (const assessment of assessments) byVerdict[assessment.verdict] = (byVerdict[assessment.verdict] ?? 0) + 1
    const lines = [
      `promises: ${promises.length} (active ${promises.filter((p) => p.status === 'active').length}, probation ${promises.filter((p) => p.status === 'probation').length}, suspended ${promises.filter((p) => p.status === 'suspended').length})`,
      `jobs: ${jobs.length} (open ${jobs.filter((job) => !job.closedAt).length})`,
      `assessments: ${assessments.length} · fulfilled ${byVerdict.fulfilled} · violated ${byVerdict.violated} · undetermined ${byVerdict.undetermined}`,
      `breaches: ${this.state.breaches.length} · unattributed observations: ${this.state.counters.observations}`,
      `ledger: seq ${this.ledger.lastSeq}, read-only ${this.ledger.readonly}`,
    ]
    return lines.join('\n')
  }

  #renderLedger(limit) {
    const verify = this.ledger.verifyChain()
    let tail = ''
    try {
      const lines = readTail(this.ledger.file, 40)
      tail = lines.slice(-limit).map((line) => {
        const event = JSON.parse(line)
        return `#${event.seq} ${event.at} ${event.type}`
      }).join('\n')
    } catch (error) {
      tail = `tail unreadable: ${error.message}`
    }
    return `chain: ${verify.ok ? 'ok' : `broken (${verify.reason})`}, events ${verify.events}\n${tail}`
  }

  #thresholds(promise) {
    return {
      pass: promise.assessment?.passThreshold ?? this.config.assessment.passThreshold,
      claim: this.config.assessment.claimThreshold,
      fail: promise.assessment?.failThreshold ?? this.config.assessment.failThreshold,
      minConfidence: promise.assessment?.minConfidence ?? this.config.assessment.minConfidence,
    }
  }

  #relative(capability, semantic) {
    if (!semantic || semantic.absolute == null || semantic.inputQuality == null) return undefined
    const bucket = Math.round(semantic.inputQuality * 4)
    const samples = []
    for (const assessment of this.state.assessments.values()) {
      if (assessment.capability !== capability) continue
      if (assessment.layers?.absolute == null || assessment.layers?.inputQuality == null) continue
      if (Math.round(assessment.layers.inputQuality * 4) !== bucket) continue
      samples.push(assessment.layers.absolute)
    }
    if (samples.length < 3) return 0.5
    samples.sort((a, b) => a - b)
    const baseline = samples[Math.floor(samples.length / 2)]
    return Math.min(1, Math.max(0, 0.5 + (semantic.absolute - baseline) / 2))
  }

  #applyBreach(promise, job, assessment, before) {
    let action = 'none'
    let status = promise.status
    if (before.lower < this.config.trust.probationFloor && promise.status !== 'suspended') {
      if (promise.status === 'probation') {
        action = 'suspend'
        status = 'suspended'
      } else {
        action = 'probation'
        status = 'probation'
      }
    } else if (promise.status === 'active') {
      action = 'probation'
      status = 'probation'
    }
    if (status !== promise.status) {
      this.ledger.append('promise/updated', {
        promise: { ...promise, status, probationPasses: status === 'probation' ? 0 : promise.probationPasses, updatedAt: nowIso(), version: promise.version + 1 },
      })
    }
    const breach = {
      jobId: job.id,
      promiseId: promise.id,
      agent: promise.agent,
      capability: promise.capability,
      action,
      reason: `${assessment.failureMode ?? 'violation'}: ${assessment.rationale}`,
    }
    this.ledger.append('breach', breach)
    return breach
  }

  #compositionHealth(children) {
    let mass = 0
    let weighted = 0
    let weakest = 0.5
    for (const child of children) {
      const view = this.trustFor(child.agent, child.capability)
      if (view.count === 0) continue
      mass += view.mass
      weighted += view.lower * view.mass
      weakest = Math.min(weakest, view.lower)
    }
    return {
      estimate: true,
      score: mass > 0 ? weighted / mass : 0.5,
      weakest,
      evidenceMass: mass,
      note: 'estimate only: rolled up from child trust, not the composition’s own record',
    }
  }

  #redact(value) {
    if (!this.config.redaction.enabled) return String(value)
    let text = String(value)
    for (const pattern of this.config.redaction.stripPatterns) {
      try {
        text = text.replace(new RegExp(pattern, 'g'), '[REDACTED]')
      } catch {
        // ignore bad operator patterns
      }
    }
    return text
  }

  #budgetKey(sessionId, turn) {
    return `${sessionId ?? 'none'}:${turn ?? 0}`
  }

  #budgetExhausted(sessionId, turn) {
    const key = this.#budgetKey(sessionId, turn)
    return (this.budget.get(key) ?? 0) >= this.config.assessment.maxJevCallsPerTurn
  }

  #spendBudget(sessionId, turn) {
    const key = this.#budgetKey(sessionId, turn)
    this.budget.set(key, (this.budget.get(key) ?? 0) + 1)
  }

  async #runChecks(promise, cwd) {
    const checks = Array.isArray(promise.checks) ? promise.checks : []
    const results = []
    for (const check of checks) {
      const id = check.id ?? 'check'
      if (!check.run) {
        results.push({ id, ok: null, skipped: true, detail: 'no command' })
        continue
      }
      if (check.source !== 'config' && !this.config.checks.allowModelDeclared) {
        results.push({ id, ok: null, skipped: true, detail: 'model-declared check not allowed by config' })
        continue
      }
      const allowed = this.config.checks.allowlist.some((pattern) => {
        try {
          return new RegExp(pattern).test(check.run)
        } catch {
          return false
        }
      })
      if (!allowed) {
        results.push({ id, ok: null, skipped: true, detail: 'command not in checks.allowlist' })
        continue
      }
      const requested = Number.isFinite(check.timeoutMs) ? check.timeoutMs : this.config.checks.timeoutMs
      const timeoutMs = Math.min(Math.max(requested, 1000), this.config.checks.timeoutMs)
      const started = Date.now()
      const outcome = await execCommand(check.run, cwd ?? process.cwd(), timeoutMs)
      if (outcome.code === null) {
        // A timeout or a failed start is a missing measurement, not a failed promise.
        results.push({
          id,
          ok: null,
          skipped: true,
          detail: outcome.timedOut ? `check timed out after ${timeoutMs}ms` : 'check failed to start',
        })
      } else {
        results.push({ id, ok: outcome.code === 0, skipped: false, detail: `exit ${outcome.code} in ${Date.now() - started}ms` })
      }
    }
    return results
  }

  #trustDelta(agent, capability, evidence, before) {
    if (!evidence) return null
    const after = this.trustFor(agent, capability)
    return {
      before: before ? Number(before.score.toFixed(3)) : null,
      score: Number(after.score.toFixed(3)),
      delta: before ? Number((after.score - before.score).toFixed(3)) : null,
      lower: Number(after.lower.toFixed(3)),
      mass: Number(after.mass.toFixed(2)),
      count: after.count,
      evidenceWeight: Number(evidence.weight.toFixed(3)),
    }
  }

  #recover(promise, verdict) {
    if (promise.status !== 'probation' || verdict !== 'fulfilled') return null
    const passes = (promise.probationPasses ?? 0) + 1
    if (passes >= this.config.trust.probationRecovery) {
      this.ledger.append('promise/updated', {
        promise: { ...promise, status: 'active', probationPasses: 0, updatedAt: nowIso(), version: promise.version + 1 },
      })
      return { action: 'restored', passes }
    }
    this.ledger.append('promise/updated', {
      promise: { ...promise, probationPasses: passes, updatedAt: nowIso(), version: promise.version + 1 },
    })
    return { action: 'probation-progress', passes }
  }
}

function guidanceFor(hint, jobId) {
  const settle = `then call promise_settle with jobId "${jobId}"`
  switch (hint?.kind) {
    case 'subagent':
      return `invoke a subagent with agent_preset="${hint.agentPreset}" when the subagent tool is mounted, ${settle}`
    case 'team':
      return `spawn or message teammate "${hint.member}" (spawn_teammate / send_message), ${settle}`
    case 'bot':
      return `send the task to DS Bot "${hint.bot}" with message_bot when ds-bot is installed, ${settle}`
    case 'tool':
      return `call the "${hint.tool}" tool, ${settle}`
    case 'composition':
      return `run the "${hint.name}" composition, ${settle}`
    default:
      return `invoke ${hint?.agent ?? 'the recommended agent'}, ${settle}`
  }
}

function readTail(file, count) {
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  return lines.slice(-count)
}

function definedOnly(value = {}) {
  const out = {}
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (entry !== undefined) out[key] = entry
  }
  return out
}

function normalizeQos(qos = {}) {
  const out = {}
  if (Number.isFinite(qos.minQuality)) out.minQuality = qos.minQuality
  if (Number.isFinite(qos.maxLatencyMs)) out.maxLatencyMs = qos.maxLatencyMs
  if (typeof qos.requiredFormat === 'string') out.requiredFormat = qos.requiredFormat
  if (Number.isFinite(qos.maxCostUsd)) out.maxCostUsd = qos.maxCostUsd
  return out
}

function normalizeRequirements(requirements) {
  if (!Array.isArray(requirements)) return []
  return requirements
    .filter((requirement) => requirement && requirement.id && requirement.text)
    .map((requirement) => ({ id: String(requirement.id), text: String(requirement.text) }))
}

function normalizeChecks(checks, declaredBy = 'agent') {
  if (!Array.isArray(checks)) return []
  return checks
    .filter((check) => check && typeof check.run === 'string')
    .map((check) => ({
      id: String(check.id ?? check.run).slice(0, 64),
      run: String(check.run).slice(0, 512),
      // A model-declared check can never promote itself to "config": the model
      // controls this field, so trusting it would make the gate meaningless.
      source: declaredBy === 'system' ? 'config' : 'model',
      timeoutMs: Number.isFinite(check.timeoutMs) ? check.timeoutMs : undefined,
    }))
}

function normalizeSignals(signals = {}) {
  return {
    tool: Array.isArray(signals?.tool) ? signals.tool.filter((tool) => typeof tool === 'string') : [],
    autoAttribute: signals?.autoAttribute === true,
  }
}

function normalizeAssessment(assessment, config) {
  const policy = ['L0', 'L1', 'L2', 'L3', 'auto'].includes(String(assessment?.policy)) ? String(assessment.policy) : 'auto'
  const unit = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined)
  let passThreshold = unit(assessment?.passThreshold)
  let failThreshold = unit(assessment?.failThreshold)
  // A model-declared pair that cannot be ordered is ignored; config defaults win.
  if (passThreshold !== undefined && failThreshold !== undefined && failThreshold >= passThreshold) {
    passThreshold = undefined
    failThreshold = undefined
  }
  return {
    policy,
    sampleRate: Number.isFinite(assessment?.sampleRate) ? Math.min(1, Math.max(0, assessment.sampleRate)) : undefined,
    passThreshold,
    failThreshold,
    minConfidence: unit(assessment?.minConfidence),
  }
}

function normalizeConstraints(constraints = {}) {
  const out = {}
  if (Number.isFinite(constraints?.maxLatencyMs)) out.maxLatencyMs = constraints.maxLatencyMs
  if (Number.isFinite(constraints?.minQuality)) out.minQuality = constraints.minQuality
  if (typeof constraints?.requiredFormat === 'string') out.requiredFormat = constraints.requiredFormat
  return out
}

function checkEnv() {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'PWD']
  const env = { NO_COLOR: '1' }
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key]
  return env
}

function execCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
      env: checkEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // already gone
        }
      }
      resolve({ code: null, timedOut: true })
    }, timeoutMs)
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, timedOut: false })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, timedOut: false })
    })
    child.stdout.resume()
    child.stderr.resume()
  })
}

function renderTrust(rows) {
  if (rows.length === 0) return 'no promises declared'
  const lines = ['agent                          capability               trust  lower  mass  n  status']
  for (const row of rows) {
    lines.push(`${row.agent.padEnd(30).slice(0, 30)} ${row.capability.padEnd(24).slice(0, 24)} ${row.score.toFixed(2)}  ${row.lower.toFixed(2)}  ${row.mass.toFixed(1).padStart(4)}  ${String(row.count).padStart(2)}  ${row.status}`)
  }
  return lines.join('\n')
}

function renderPromises(rows) {
  if (rows.length === 0) return 'no promises declared'
  return rows.map((promise) => `- ${promise.agent} · ${promise.capability} (v${promise.version}, ${promise.status})\n  ${promise.statement}`).join('\n')
}

function renderBreaches(rows) {
  if (rows.length === 0) return 'no breaches recorded'
  return rows.map((breach) => `- ${breach.agent} · ${breach.capability}: ${breach.action} (${breach.reason})`).join('\n')
}

export { parseMs, matchGlobs, effectiveN }
