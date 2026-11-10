/**
 * The five model-facing tools. Each one is a thin adapter over PromiseEngine;
 * all policy (routing, verdicts, breach) stays in the engine, not in a prompt.
 * @module dsh-promise/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { blocksToText } from './util.js'
import { invokeHint } from './router.js'

const string = (description, extra = {}) => ({ type: 'string', description, ...extra })
const number = (description) => ({ type: 'number', description })
const integer = (description) => ({ type: 'integer', description })

/** Drop undefined/null object fields so tool output stays lossless JSON. */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined || entry === null) continue
      out[key] = clean(entry)
    }
    return out
  }
  return value
}

const OBJECT = (properties, required = true) => ({ type: 'object', additionalProperties: false, properties })

const stringArray = (description, itemDescription = '') => ({
  type: 'array',
  description,
  items: { type: 'string', description: itemDescription },
})

const candidateSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    promiseId: string('promise id'),
    agent: string('agent id'),
    capability: string('capability'),
    trust: number('aggregated trust'),
    lower: number('wilson lower bound used for ranking'),
    mass: number('decayed evidence mass'),
    count: integer('number of assessments'),
    score: number('final routing score'),
    reasons: stringArray('why this candidate ranked here'),
    invoke: {
      type: 'object',
      additionalProperties: true,
      properties: {
        kind: string('subagent | team | bot | tool | composition | other', { required: true }),
        agentPreset: string('subagent preset'),
        member: string('Agent Teams member name'),
        bot: string('ds-bot name'),
        tool: string('tool name'),
        name: string('composition name'),
        agent: string('raw agent id'),
      },
    },
  },
}

/**
 * @param {import('./engine.js').PromiseEngine} engine
 * @param {import('./collector.js').SessionCollector} collector
 * @param {(level:string, message:string)=>void} log
 */
export function buildTools(engine, collector, log, deps = {}) {
  const contextOf = (exec) => {
    const session = exec?.agent?.session
    const sessionId = session?.id ? String(session.id) : undefined
    return {
      sessionId,
      turn: sessionId ? collector.lastTurn(sessionId) : 0,
      cwd: session?.header?.cwd,
      signal: exec?.signal,
    }
  }

  const declare = defineTool({
    name: 'promise_declare',
    description: 'Declare or update a falsifiable quality promise for one agent and one capability. A good promise states the conditions, the measurable quality bar, and the evidence that can falsify it. Use capability names such as code.change or research.brief. Re-declaring the same agent+capability bumps its version.',
    parameters: {
      agent: string('Agent id: preset:<name>, tool:<name>, or compose:<name>', { required: true }),
      capability: string('Capability id, lowercase dotted, e.g. code.change', { required: true }),
      statement: string('One falsifiable sentence: what is promised under which conditions', { required: true }),
      qos: OBJECT({
        minQuality: number('minimum absolute quality 0..1'),
        maxLatencyMs: number('latency ceiling in milliseconds'),
        requiredFormat: string('required output format: text, markdown, json, diff'),
        maxCostUsd: number('cost ceiling'),
      }, false),
      assessment: OBJECT({
        policy: string('assessment level policy', { enum: ['L0', 'L1', 'L2', 'L3', 'auto'] }),
        sampleRate: number('L2 sampling rate 0..1'),
        passThreshold: number('noul threshold for fulfilled'),
        failThreshold: number('noul threshold for violated'),
        minConfidence: number('minimum semantic confidence'),
      }, false),
      requirements: {
        type: 'array',
        description: 'Concrete acceptance criteria; used for requirement-level attribution',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: string('short id', { required: true }),
            text: string('what must be true', { required: true }),
          },
        },
      },
      rules: {
        type: 'array',
        description: 'Structural rules: files-within, diff-touches, max-files, no-match, required-sections, json-schema, tool-ok, max-latency, min-bytes',
        items: { type: 'object', additionalProperties: true },
      },
      checks: {
        type: 'array',
        description: 'Commands the host runs at settlement to falsify the promise. Inert unless the operator opts in.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: string('check id', { required: true }),
            run: string('shell command', { required: true }),
            source: string('model or config', { enum: ['model', 'config'] }),
            timeoutMs: integer('timeout in milliseconds'),
          },
        },
      },
      signals: OBJECT({
        tool: stringArray('tool names whose calls are evidence for this promise', 'tool name'),
        autoAttribute: { type: 'boolean', description: 'opt in to attributing whole turns that used these tools' },
      }, false),
      status: string('draft keeps the promise out of routing', { enum: ['active', 'draft'] }),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          promiseId: string('promise id', { required: true }),
          version: integer('version', { required: true }),
          status: string('status', { required: true }),
          warnings: { ...stringArray('declaration warnings'), required: true },
          text: string('human-readable summary', { required: true }),
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Declare promise ${args.capability}`,
      kind: 'other',
      rawInput: { agent: args.agent, capability: args.capability },
    }),
    presentResult: (_args, value) => ({
      card: 'generic',
      title: `Promise v${value.version} ${value.status}`,
      content: [{ type: 'text', text: value.text }],
    }),
    execute(args, exec) {
      const { promise, warnings } = engine.declare(args, { declaredBy: 'agent' })
      const text = `promise ${promise.id} v${promise.version} (${promise.status}) for ${promise.agent} · ${promise.capability}`
        + (warnings.length > 0 ? `\nwarnings:\n- ${warnings.join('\n- ')}` : '')
      return Promise.resolve(clean({ promiseId: promise.id, version: promise.version, status: promise.status, warnings, text }))
    },
  })

  const select = defineTool({
    name: 'promise_select',
    description: 'Match a task to the best-evidenced promise for a capability. Returns a ranked shortlist with the reasons behind each rank, a job id, and the assessment level policy chose. Call this before delegating substantive work; then invoke the recommended agent and settle the job afterwards.',
    parameters: {
      capability: string('Capability required by the task', { required: true }),
      need: string('What the task needs, in one or two sentences', { required: true }),
      constraints: OBJECT({
        maxLatencyMs: number('hard latency budget'),
        minQuality: number('minimum acceptable trust lower bound'),
        requiredFormat: string('required output format'),
      }, false),
      riskTier: integer('0 read-only, 1 local write, 2 external effect, 3 irreversible'),
      reversible: { type: 'boolean', description: 'Whether the effect can be undone' },
      value: string('low or high value output', { enum: ['low', 'high'] }),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: string('job id, empty when nothing is eligible', { required: true }),
          hasCandidate: { type: 'boolean', required: true },
          promiseId: string('recommended promise id'),
          agent: string('recommended agent'),
          capability: string('capability'),
          trust: number('recommended trust'),
          lower: number('recommended trust lower bound'),
          level: integer('planned assessment level', { required: true }),
          levelReasons: { ...stringArray('why this level'), required: true },
          candidates: { type: 'array', items: candidateSchema, required: true },
          guidance: string('next step'),
          text: string('human-readable summary', { required: true }),
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Select promise for ${args.capability}`,
      kind: 'other',
      rawInput: { capability: args.capability, riskTier: args.riskTier },
    }),
    presentResult: (_args, value) => ({
      card: 'generic',
      title: value.hasCandidate ? `Recommended ${value.agent}` : 'No eligible promise',
      content: [{ type: 'text', text: value.text }],
    }),
    execute(args, exec) {
      const context = contextOf(exec)
      const result = engine.select(args, context)
      const lines = []
      if (!result.hasCandidate && result.candidates.length === 0) {
        lines.push(result.guidance ?? 'no eligible promise')
      } else {
        lines.push(`job ${result.jobId} · level L${result.level} (${result.levelReasons.join('; ')})`)
        for (const candidate of result.candidates) {
          const marker = candidate.promiseId === result.recommended?.promiseId ? '*' : ' '
          lines.push(`${marker} ${candidate.agent} · ${candidate.capability} · trust ${candidate.trust.toFixed(2)} (lower ${candidate.lower.toFixed(2)}, ${candidate.count} assessments)`)
          for (const reason of candidate.reasons) lines.push(`    - ${reason}`)
        }
        if (result.guidance) lines.push(result.guidance)
      }
      return Promise.resolve(clean({
        jobId: result.jobId,
        hasCandidate: Boolean(result.recommended),
        promiseId: result.recommended?.promiseId,
        agent: result.recommended?.agent,
        capability: args.capability,
        trust: result.recommended?.trust,
        lower: result.recommended?.lower,
        level: result.level,
        levelReasons: result.levelReasons,
        candidates: result.candidates.map((candidate) => ({
          promiseId: candidate.promiseId,
          agent: candidate.agent,
          capability: candidate.capability,
          trust: Number(candidate.trust.toFixed(3)),
          lower: Number(candidate.lower.toFixed(3)),
          mass: Number(candidate.mass.toFixed(2)),
          count: candidate.count,
          score: candidate.score,
          reasons: candidate.reasons,
          invoke: candidate.invoke,
        })),
        guidance: result.guidance,
        text: lines.join('\n'),
      }))
    },
  })

  const settle = defineTool({
    name: 'promise_settle',
    description: 'Settle a promise job after the work finishes: run the declared checks, evaluate the output at the planned assessment level, update trust, and apply breach policy. Pass the job id from promise_select. Trust only changes through settlement; never claim reliability without it.',
    parameters: {
      jobId: string('Job id returned by promise_select', { required: true }),
      outcome: string('Whether the execution completed', { required: true, enum: ['success', 'failure'] }),
      output: string('The produced output (diff, report, JSON). Falls back to the collected assistant text.'),
      latencyMs: number('Observed latency in milliseconds'),
      promiseId: string('Override the promise if you picked a different candidate than recommended'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: string('job id', { required: true }),
          agent: string('agent that held the promise'),
          capability: string('capability'),
          levelReasons: { ...stringArray('why this level') },
          verdict: string('fulfilled, violated or undetermined', { required: true }),
          level: integer('assessment level', { required: true }),
          confidence: number('confidence'),
          failureMode: string('failure attribution'),
          unmetRequirement: string('which requirement was unmet'),
          rationale: string('why this verdict'),
          layers: OBJECT({
            absolute: number('0..1'),
            relative: number('0..1'),
            process: number('0..1'),
            inputQuality: number('0..1'),
          }, false),
          trust: OBJECT({
            before: number('trust before'),
            score: number('trust after'),
            delta: number('change'),
            lower: number('lower bound after'),
            mass: number('evidence mass after'),
            count: integer('assessments after'),
            evidenceWeight: number('weight of this evidence'),
          }, false),
          breach: OBJECT({
            jobId: string('job id'),
            promiseId: string('promise id'),
            agent: string('agent id'),
            capability: string('capability'),
            action: string('none, probation or suspend'),
            reason: string('why'),
          }, false),
          closedAt: string('settlement timestamp when the job was already settled'),
          recovery: OBJECT({
            action: string('probation-progress or restored'),
            passes: integer('consecutive passes'),
          }, false),
          rules: { type: 'array', items: { type: 'object', additionalProperties: true } },
          semantic: {
            type: 'object',
            additionalProperties: true,
            properties: {
              model: string('resolved model'),
              samples: integer('assessment samples'),
              bytes: integer('state size'),
              truncated: { type: 'boolean' },
              skipped: { type: 'boolean' },
              code: string('skip reason'),
              message: string('skip detail'),
            },
          },
          note: string('extra context'),
          text: string('human-readable summary', { required: true }),
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Settle promise job',
      kind: 'other',
      rawInput: { jobId: args.jobId },
    }),
    presentResult: (_args, value) => ({
      card: 'generic',
      title: `Settlement: ${value.verdict}`,
      content: [{ type: 'text', text: value.text }],
    }),
    async execute(args, exec) {
      const context = contextOf(exec)
      const result = await engine.settle(args, context)
      const lines = [
        `job ${result.jobId} · ${result.verdict ?? 'undetermined'} · L${result.level ?? '?'}${result.confidence != null ? ` · confidence ${result.confidence}` : ''}`,
      ]
      if (result.layers && Object.values(result.layers).some((value) => value != null)) {
        const parts = []
        if (result.layers.absolute != null) parts.push(`absolute ${result.layers.absolute.toFixed(2)}`)
        if (result.layers.relative != null) parts.push(`relative ${result.layers.relative.toFixed(2)}`)
        if (result.layers.process != null) parts.push(`process ${result.layers.process.toFixed(2)}`)
        lines.push(parts.join(' · '))
      }
      if (result.failureMode && result.failureMode !== 'none') lines.push(`failure mode: ${result.failureMode}`)
      if (result.unmetRequirement && result.unmetRequirement !== 'none') lines.push(`unmet requirement: ${result.unmetRequirement}`)
      if (result.rationale) lines.push(result.rationale)
      if (result.trust) lines.push(`trust ${result.trust.before ?? '?'} → ${result.trust.score} (${result.trust.count} assessments, mass ${result.trust.mass})`)
      if (result.breach && result.breach.action !== 'none') lines.push(`breach action: ${result.breach.action} — ${result.breach.reason}`)
      if (result.recovery) lines.push(`probation ${result.recovery.action} (${result.recovery.passes})`)
      if (result.note) lines.push(result.note)
      return clean({ ...result, text: lines.join('\n') })
    },
  })

  const inspect = defineTool({
    name: 'promise_inspect',
    description: 'Read the promise ledger: trust per agent and capability (with evidence mass), declarations, breach history, or a summary. Trust numbers are meaningless without their evidence count and assessor, so read the whole row.',
    parameters: {
      what: string('What to inspect', { enum: ['summary', 'trust', 'promise', 'breach', 'ledger'] }),
      agent: string('Filter by agent id'),
      capability: string('Filter by capability'),
      limit: integer('Maximum rows (1-100)'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          what: string('what was inspected', { required: true }),
          text: string('human-readable report', { required: true }),
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: (args) => ({ card: 'generic', title: `Inspect ${args.what ?? 'summary'}`, kind: 'read' }),
    presentResult: (_args, value) => ({
      card: 'generic',
      title: `Promise ${value.what}`,
      content: [{ type: 'text', text: value.text }],
    }),
    execute(args) {
      const result = engine.inspect(args)
      return Promise.resolve(clean({ what: result.what, text: result.text }))
    },
  })

  const compose = defineTool({
    name: 'promise_compose',
    description: 'Declare a superagent: several child agents behind one external promise. The composition gets its own promise record and its own trust; child health is reported only as a labelled estimate. Replace children later without changing what callers rely on.',
    parameters: {
      name: string('Composition name', { required: true }),
      external: {
        type: 'object',
        additionalProperties: false,
        required: true,
        properties: {
          capability: string('capability the composition promises', { required: true }),
          statement: string('the external promise', { required: true }),
          qos: OBJECT({
            minQuality: number('minimum quality'),
            maxLatencyMs: number('latency ceiling'),
            requiredFormat: string('required format'),
          }, false),
          requirements: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: string('id', { required: true }),
                text: string('text', { required: true }),
              },
            },
          },
        },
      },
      children: {
        type: 'array',
        description: 'Child agents and the capability each contributes',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            agent: string('child agent id', { required: true }),
            capability: string('child capability', { required: true }),
            weight: number('relative weight'),
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          compositionId: string('composition id', { required: true }),
          externalPromiseId: string('external promise id', { required: true }),
          health: OBJECT({
            estimate: { type: 'boolean' },
            score: number('estimate'),
            weakest: number('weakest child lower bound'),
            evidenceMass: number('rolled-up evidence mass'),
            note: string('disclaimer'),
          }, false),
          warnings: { ...stringArray('declaration warnings'), required: true },
          text: string('human-readable summary', { required: true }),
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: (args) => ({ card: 'generic', title: `Compose ${args.name}`, kind: 'other' }),
    presentResult: (_args, value) => ({
      card: 'generic',
      title: `Composition ${value.compositionId}`,
      content: [{ type: 'text', text: value.text }],
    }),
    execute(args) {
      const result = engine.compose(args)
      const health = result.health
      const text = `composition ${result.composition.id} · external promise ${result.externalPromise.id}\n`
        + `children: ${result.composition.children.map((child) => `${child.agent}(${child.capability})`).join(', ') || 'none'}\n`
        + `health estimate ${health.score.toFixed(2)} (weakest ${health.weakest.toFixed(2)}, mass ${health.evidenceMass.toFixed(1)}) — ${health.note}`
      return Promise.resolve(clean({
        compositionId: result.composition.id,
        externalPromiseId: result.externalPromise.id,
        health,
        warnings: result.warnings,
        text,
      }))
    },
  })


  const delegate = defineTool({
    name: 'promise_delegate',
    description: 'Dispatch an open promise job to its agent and let the plugin settle it when the work finishes: spawns or messages an Agent Teams teammate, or starts a subagent activation, then links the job to the child session. Use this instead of calling spawn_teammate/send_message/subagent directly when the work belongs to a promise.',
    parameters: {
      jobId: string('Job id returned by promise_select', { required: true }),
      prompt: string('Complete initial task for the delegated agent', { required: true }),
      name: string('Teammate name to spawn or reuse (defaults to the team:<name> in the job)'),
      description: string('Short responsibility description for a new teammate'),
      context: string('fresh or fork teammate context', { enum: ['fresh', 'fork'] }),
      preset: string('Subagent preset override (defaults to the preset in the job agent id)'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: string('job id', { required: true }),
          dispatched: { type: 'boolean', required: true },
          family: string('team, subagent or unsupported', { required: true }),
          memberId: string('child session id'),
          memberName: string('teammate name or preset'),
          text: string('human-readable summary', { required: true }),
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Delegate promise job',
      kind: 'other',
      rawInput: { jobId: args.jobId, name: args.name },
    }),
    presentResult: (_args, value) => ({
      card: 'generic',
      title: value.dispatched ? `Delegated to ${value.family}` : 'Delegation failed',
      content: [{ type: 'text', text: value.text }],
    }),
    async execute(args, exec) {
      const job = engine.state.jobs.get(String(args.jobId))
      if (!job) throw new Error(`unknown jobId: ${args.jobId}`)
      if (job.closedAt) throw new Error('job is already settled')
      const promise = [...engine.state.promises.values()].find((candidate) => candidate.id === job.promiseId)
      if (!promise) throw new Error('the job promise no longer exists')
      const hint = invokeHint(job.agent)
      const content = [{ type: 'text', text: args.prompt }]

      if (hint.kind === 'team') {
        const teams = deps.getTeams?.()
        if (!teams) throw new Error('Agent Teams is not mounted in this profile')
        const name = args.name ?? hint.member ?? String(job.agent).replace(/^team:/, '')
        const members = teams.listMembers(exec.agent)
        const existing = members.find((member) => member.name === name)
        let member
        if (existing) {
          await teams.sendMessage(exec.agent, { target: name, content, signal: exec.signal })
          member = existing
        } else {
          const spawned = await teams.spawnTeammate(exec.agent, {
            name,
            description: args.description ?? String(job.request ?? promise.statement).slice(0, 200),
            prompt: content,
            context: args.context === 'fork' ? 'fork' : 'fresh',
            provider: args.context === 'fork' ? 'fork' : 'spawn',
            signal: exec.signal,
          })
          member = spawned.member
        }
        engine.linkDelegation(args.jobId, {
          kind: 'team',
          name: member.name,
          sessionId: String(member.id),
          leadAgent: exec.agent,
          teams,
        })
        return clean({
          jobId: args.jobId,
          dispatched: true,
          family: 'team',
          memberId: String(member.id),
          memberName: member.name,
          text: `delegated job ${args.jobId} to teammate ${member.name} (${member.status}); it settles automatically when the teammate goes inactive`,
        })
      }

      if (hint.kind === 'subagent') {
        const subagents = deps.getSubagents?.()
        if (!subagents) throw new Error('the subagent service is not mounted in this profile')
        const preset = args.preset ?? hint.agentPreset
        const activation = await subagents.startActivation({
          provider: 'spawn',
          label: `promise ${promise.capability}`.slice(0, 80),
          request: {
            prompt: content,
            parent: exec.agent,
            signal: exec.signal,
            ...(preset ? { agentPreset: preset } : {}),
          },
          signal: exec.signal,
          delivery: 'caller',
        })
        engine.linkDelegation(args.jobId, {
          kind: 'subagent',
          name: preset ?? 'subagent',
          sessionId: String(activation.childId),
        })
        void activation.result
          .then((result) => engine.settleDelegated(args.jobId, { output: blocksToText(result.output, 32_768) }))
          .catch((error) => engine.settleDelegated(args.jobId, { error: String(error?.message ?? error) }))
          .finally(() => {
            void activation.dispose?.().catch(() => {})
          })
        return clean({
          jobId: args.jobId,
          dispatched: true,
          family: 'subagent',
          memberId: String(activation.childId),
          memberName: preset,
          text: `delegated job ${args.jobId} to subagent ${preset ?? '(parent preset)'}; it settles automatically when the activation finishes`,
        })
      }

      throw new Error(`promise_delegate does not support ${hint.kind} agents; settle this job manually`)
    },
  })

  return [declare, select, settle, delegate, inspect, compose]
}
