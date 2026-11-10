/**
 * Assessment assembly: build the typed Jev questions and the structured state,
 * map answers back to the three evaluation layers, and handle boundary
 * resampling plus truncate-and-retry when the state is too large.
 * @module dsh-promise/assess
 */
import { truncateMiddle } from './util.js'

const LEVELS_QUALITY = ['Unusable', 'Major rework needed', 'Usable with edits', 'Good', 'Excellent, ship-ready']
const LEVELS_INPUT = ['Unusable / contradictory', 'Missing key info', 'Adequate', 'Clear', 'Complete and precise']
const LEVELS_PROCESS = [
  'Dishonest or ignores constraints',
  'Sloppy',
  'Acceptable',
  'Careful',
  'Exemplary: surfaced limits and conflicts',
]

/**
 * One call answers all layers. Questions stay atomic: the engine, not the
 * model, combines them into a verdict.
 * @param {object} promise
 */
export function buildQuestions(promise) {
  const questions = {
    addresses_request: {
      type: 'noul',
      instructions: 'Does `output` actually implement what `request` asked for?',
      criteria: {
        true: 'The requested behavior is present in the artifact',
        false: 'Missing, partial, or unrelated',
      },
    },
    claims_contradicted: {
      type: 'noul',
      instructions: 'Does any item in `evidence` contradict a factual claim the agent makes in `output` about its work? Answer false when `evidence` is empty.',
      criteria: {
        true: 'At least one factual claim is contradicted by evidence',
        false: 'No factual claim is contradicted',
      },
    },
    absolute_quality: {
      type: 'score',
      instructions: 'How useful is `output` to the requester, ignoring how hard the input was?',
      criteria: LEVELS_QUALITY,
    },
    input_quality: {
      type: 'score',
      instructions: 'How clear, complete and internally consistent is `request`?',
      criteria: LEVELS_INPUT,
    },
    process_quality: {
      type: 'score',
      instructions: 'Did the agent act professionally: flag ambiguity/conflicts, state limits, follow the required format?',
      criteria: LEVELS_PROCESS,
    },
    failure_mode: {
      type: 'choice',
      instructions: 'If `output` falls short, what is the dominant cause?',
      criteria: {
        none: 'No meaningful shortfall',
        input: 'The request itself was deficient',
        capability: 'The agent lacked the ability',
        process: 'The agent was careless or cut corners',
        spec: 'The promise/acceptance criteria were ambiguous',
        tool: 'A tool or dependency failed',
      },
    },
  }

  const requirements = Array.isArray(promise.requirements) ? promise.requirements : []
  if (requirements.length > 0) {
    const criteria = {}
    for (const requirement of requirements) {
      criteria[requirement.id] = requirement.text
    }
    criteria.none = 'All requirements are met'
    questions.unmet_requirement = {
      type: 'choice',
      instructions: 'If `output` falls short, which specific requirement from `request` is unmet?',
      criteria,
    }
  }
  return questions
}

function clip(value, maxBytes) {
  return truncateMiddle(String(value ?? ''), maxBytes)
}

/**
 * Build the state document within a byte budget.
 * @returns {{state:object, truncated:boolean, bytes:number}}
 */
export function buildState({ promise, job, observation, output, maxBytes = 24_576, redactText = (value) => value }) {
  const outputText = redactText(String(output?.text ?? ''))
  const requestText = redactText(String(job?.request ?? ''))
  const evidence = []
  for (const [index, rule] of (observation.rules ?? []).entries()) {
    evidence.push({ id: `r${index + 1}`, kind: 'rule', name: rule.id, ok: rule.ok, detail: String(rule.detail ?? '').slice(0, 200) })
  }
  for (const [index, check] of (observation.checks ?? []).entries()) {
    evidence.push({ id: `c${index + 1}`, kind: 'check', name: check.id, ok: check.ok, detail: String(check.detail ?? '').slice(0, 200) })
  }
  for (const [index, tool] of (observation.toolResults ?? []).slice(-20).entries()) {
    evidence.push({ id: `t${index + 1}`, kind: 'tool', name: tool.name, ok: tool.ok !== false })
  }

  const base = {
    promise: {
      agent: promise.agent,
      capability: promise.capability,
      statement: promise.statement,
      qos: promise.qos ?? {},
      requirements: promise.requirements ?? [],
    },
    request: { text: requestText, constraints: job?.constraints ?? {} },
    output: { format: promise.qos?.requiredFormat ?? 'text', text: '', bytes: Buffer.byteLength(outputText, 'utf8') },
    evidence,
    process: {
      toolCalls: (observation.toolResults ?? []).length,
      errors: (observation.toolResults ?? []).filter((tool) => tool.ok === false).length,
      retries: observation.retries ?? 0,
      durationMs: observation.durationMs ?? 0,
    },
  }

  let truncated = false
  let budget = Math.max(512, maxBytes - Buffer.byteLength(JSON.stringify({ ...base, output: { ...base.output, text: '' } }), 'utf8') - 64)
  let text = outputText
  if (Buffer.byteLength(text, 'utf8') > budget) {
    text = clip(text, budget)
    truncated = true
  }
  base.output.text = text

  let serialized = JSON.stringify(base)
  while (Buffer.byteLength(serialized, 'utf8') > maxBytes && base.output.text.length > 0) {
    const overflow = Buffer.byteLength(serialized, 'utf8') - maxBytes
    budget = Math.max(0, Buffer.byteLength(base.output.text, 'utf8') - overflow - 64)
    base.output.text = clip(base.output.text, budget)
    truncated = true
    serialized = JSON.stringify(base)
  }
  return { state: base, truncated, bytes: Buffer.byteLength(serialized, 'utf8') }
}

/** Map raw Jev answers to the engine's semantic shape. */
export function mapAnswers(answers = {}) {
  const score = (key) => {
    const value = answers?.[key]?.score
    return typeof value === 'number' ? value / 4 : undefined
  }
  const confidences = []
  for (const key of ['absolute_quality', 'input_quality', 'process_quality', 'failure_mode', 'unmet_requirement']) {
    const value = answers?.[key]?.confidence
    if (typeof value === 'number') confidences.push(value)
  }
  const confidence = confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0.5
  return {
    addressesRequest: typeof answers?.addresses_request?.noul === 'number' ? answers.addresses_request.noul : undefined,
    claimsContradicted: typeof answers?.claims_contradicted?.noul === 'number' ? answers.claims_contradicted.noul : undefined,
    absolute: score('absolute_quality'),
    inputQuality: score('input_quality'),
    process: score('process_quality'),
    failureMode: answers?.failure_mode?.choice,
    failureModeConfidence: answers?.failure_mode?.confidence,
    unmetRequirement: answers?.unmet_requirement?.choice,
    unmetConfidence: answers?.unmet_requirement?.confidence,
    confidence,
  }
}

/**
 * Ask Jev, resample near a threshold, and degrade cleanly on an oversize state.
 * @param {object} options
 * @param {import('./jev.js').JevClient} options.client
 * @param {object} options.promise
 * @param {object} options.job
 * @param {object} options.observation
 * @param {{text:string}} options.output
 * @param {object} options.config assessment config
 * @param {(value:string)=>string} [options.redactText]
 * @param {AbortSignal} [options.signal]
 * @param {(level:string, message:string)=>void} [options.logger]
 */
export async function runSemantic(options) {
  const { client, promise, job, observation, output, config } = options
  const redactText = options.redactText ?? ((value) => value)
  const questions = buildQuestions(promise)
  const built = buildState({
    promise,
    job,
    observation,
    output,
    maxBytes: config.maxStateBytes ?? 24_576,
    redactText,
  })
  const state = built.state
  let truncated = built.truncated

  const ask = async () => {
    try {
      return await client.ask(state, questions, { signal: options.signal })
    } catch (error) {
      if (error?.name !== 'JevOversizeError') throw error
      state.output.text = truncateMiddle(state.output.text, config.truncateToBytes ?? 16_384)
      state.request.text = truncateMiddle(state.request.text, 4_096)
      truncated = true
      return client.ask(state, questions, { signal: options.signal })
    }
  }

  const firstResponse = await ask()
  const first = mapAnswers(firstResponse.answers)
  let mapped = first
  let samples = 1
  let unstable = false

  const pass = config.passThreshold ?? 0.7
  const fail = config.failThreshold ?? 0.3
  const resampleBand = config.resample !== false
    && first.addressesRequest != null
    && first.addressesRequest > fail
    && first.addressesRequest < (config.boundaryHigh ?? 0.85)
  if (resampleBand) {
    const second = mapAnswers((await ask()).answers)
    samples = 2
    // Only genuinely divergent samples are unstable. Crossing a threshold by
    // noise (0.69 vs 0.71) is normal; the mean is the verdict input.
    unstable = Math.abs(first.addressesRequest - second.addressesRequest) >= 0.15
    mapped = {
      ...first,
      addressesRequest: (first.addressesRequest + second.addressesRequest) / 2,
      claimsContradicted: ((first.claimsContradicted ?? 0) + (second.claimsContradicted ?? 0)) / 2,
      unstable,
    }
  }

  return {
    semantic: { ...mapped, unstable, truncated },
    meta: {
      model: firstResponse.model ?? client.model,
      samples,
      bytes: built.bytes,
      truncated,
      usage: firstResponse.usage ?? null,
    },
  }
}
