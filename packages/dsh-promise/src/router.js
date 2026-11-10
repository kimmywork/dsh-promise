/**
 * Promise matching: eligibility first, then a transparent weighted score. The
 * router never mutates trust and always returns the reasons behind a ranking.
 * @module dsh-promise/router
 */
import { clamp01 } from './util.js'

const DEFAULT_WEIGHTS = { trust: 0.55, qos: 0.25, cost: 0.1, explore: 0.1 }

function latencyFit(constraint, promised) {
  if (!(constraint > 0) || !(promised > 0)) return 1
  return clamp01(constraint / promised)
}

function qualityFit(lower, constraintMin) {
  if (!(constraintMin > 0)) return 1
  if (lower >= constraintMin) return 1
  return clamp01(0.6 * (lower / constraintMin))
}

function formatFit(required, promised) {
  if (!required || !promised) return 1
  return required === promised ? 1 : 0.4
}

/**
 * @param {object} input
 * @param {Array<object>} input.promises candidate promise records (already filtered by capability)
 * @param {(agent:string, capability:string)=>{score:number, lower:number, mass:number, count:number}} input.lookup
 * @param {object} [input.constraints]
 * @param {{trust:number,qos:number,cost:number,explore:number}} [input.weights]
 * @param {number} [input.totalJobs]
 * @param {number} [input.explorationBonus]
 * @param {number} [input.minEvidence]
 * @param {number} [input.probationFloor]
 * @returns {{candidates:Array<object>, eligible:number}}
 */
export function rankCandidates(input) {
  const weights = { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) }
  const constraints = input.constraints ?? {}
  const totalJobs = Math.max(0, Number(input.totalJobs ?? 0))
  const explorationBonus = input.explorationBonus ?? 0.08
  const minEvidence = input.minEvidence ?? 5
  const probationFloor = input.probationFloor ?? 0.45
  const candidates = []

  for (const promise of input.promises) {
    if (!promise || promise.status === 'suspended' || promise.status === 'retired' || promise.status === 'draft') continue
    const qos = promise.qos ?? {}
    const reasons = []

    if (constraints.maxLatencyMs && qos.maxLatencyMs && qos.maxLatencyMs > constraints.maxLatencyMs) continue
    if (constraints.requiredFormat && qos.requiredFormat && qos.requiredFormat !== constraints.requiredFormat) continue

    const view = input.lookup(promise.agent, promise.capability)
    const lower = clamp01(view.lower)
    const qosFit = 0.5 * latencyFit(constraints.maxLatencyMs, qos.maxLatencyMs) + 0.5 * qualityFit(lower, constraints.minQuality)
    const format = formatFit(constraints.requiredFormat, qos.requiredFormat)
    const explore = view.mass < minEvidence ? clamp01(explorationBonus + Math.sqrt(Math.log(totalJobs + 1) / (view.mass + 1)) * 0.05) : 0
    const breachPenalty = promise.status === 'probation' ? 0.05 : 0

    const score = clamp01(
      weights.trust * lower
      + weights.qos * (qosFit * 0.7 + format * 0.3)
      + weights.cost * 0.5
      + weights.explore * explore
      - breachPenalty,
    )

    reasons.push(`trust ${view.score.toFixed(2)} (lower ${lower.toFixed(2)}, mass ${view.mass.toFixed(1)}, ${view.count} assessments)`)
    if (qos.maxLatencyMs) reasons.push(`promised latency ${qos.maxLatencyMs}ms`)
    if (qos.minQuality) reasons.push(`promised quality ≥ ${qos.minQuality}`)
    if (promise.status === 'probation') reasons.push('probation: recent breach, penalty applied')
    if (explore > 0) reasons.push(`exploration bonus for thin evidence (mass ${view.mass.toFixed(1)} < ${minEvidence})`)
    if (view.mass > 0 && lower < probationFloor) reasons.push(`lower bound below probation floor ${probationFloor}`)

    candidates.push({
      promiseId: promise.id,
      agent: promise.agent,
      capability: promise.capability,
      status: promise.status,
      trust: view.score,
      lower,
      mass: view.mass,
      count: view.count,
      qosFit: Number(qosFit.toFixed(3)),
      explore: Number(explore.toFixed(3)),
      score: Number(score.toFixed(4)),
      reasons,
      invoke: invokeHint(promise.agent),
      qos,
      assessment: promise.assessment,
    })
  }

  candidates.sort((a, b) => b.score - a.score || b.lower - a.lower || a.promiseId.localeCompare(b.promiseId))
  return { candidates, eligible: candidates.length }
}

/** Turn an agent id into a concrete invocation hint the model can act on. */
export function invokeHint(agent) {
  const value = String(agent)
  if (value.startsWith('preset:')) return { kind: 'subagent', agentPreset: value.slice('preset:'.length) }
  if (value.startsWith('tool:')) return { kind: 'tool', tool: value.slice('tool:'.length) }
  if (value.startsWith('compose:')) return { kind: 'subagent', composition: value.slice('compose:'.length) }
  return { kind: 'other', agent: value }
}
