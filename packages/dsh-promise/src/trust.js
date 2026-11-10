/**
 * Trust math: recency-weighted evidence aggregation with reversion to the prior,
 * per-assessor separation, and a Wilson lower bound for ranking.
 *
 * The score is an engineering approximation, not a truth claim: it is defined so
 * that replaying the ledger in order reproduces it exactly.
 * @module dsh-promise/trust
 */
import { clamp01 } from './util.js'

/** Reference evidence weight; converts decayed mass into a pseudo sample count. */
export const REF_WEIGHT = 0.7

/** Prior pseudo-mass: the first observation is shrunk toward the prior instead of replacing it. */
export const PRIOR_MASS = 1

export function decayFactor(dtMs, halfLifeDays) {
  if (!Number.isFinite(dtMs) || dtMs <= 0) return 1
  const halfLifeMs = Math.max(1, halfLifeDays) * 86_400_000
  return Math.pow(0.5, dtMs / halfLifeMs)
}

export function initialRecord(at, prior) {
  return { score: prior, mass: PRIOR_MASS, count: 0, updatedAt: at }
}

/**
 * Fold one evidence item into a trust record.
 *
 * Decay both the mass and the score's distance from the prior, so an agent that
 * stops being verified drifts back to "unknown" (0.5) instead of keeping an old
 * reputation forever.
 * @param {object|undefined} record
 * @param {{score:number, weight:number, at:number}} evidence
 * @param {{prior:number, halfLifeDays:number}} options
 */
export function applyEvidence(record, evidence, options) {
  const prior = clamp01(options.prior)
  const weight = Math.max(0, evidence.weight)
  const at = evidence.at
  const base = record ?? initialRecord(at, prior)
  const atMs = Number.isFinite(at) ? at : base.updatedAt
  const decay = decayFactor(atMs - base.updatedAt, options.halfLifeDays)
  const mass = base.mass * decay
  const reverted = prior + (base.score - prior) * decay
  const total = mass + weight
  const score = total <= 0 ? prior : (reverted * mass + clamp01(evidence.score) * weight) / total
  return {
    score: clamp01(score),
    mass: total,
    count: (base.count ?? 0) + 1,
    updatedAt: atMs,
  }
}

/** Combine per-assessor records for one (agent, capability) pair. */
export function aggregate(records, prior = 0.5) {
  let mass = 0
  let weighted = 0
  let count = 0
  for (const record of records) {
    mass += record.mass
    weighted += record.score * record.mass
    count += record.count ?? 0
  }
  return {
    score: mass > 0 ? clamp01(weighted / mass) : prior,
    mass,
    count,
  }
}

export function effectiveN(mass) {
  return Math.max(0, mass) / REF_WEIGHT
}

/**
 * Wilson lower bound at z=1: a cheap, explainable way to rank an agent by the
 * pessimistic end of its evidence instead of a single lucky observation.
 */
export function wilsonLower(score, n, z = 1) {
  if (!(n > 0)) return 0.5
  const p = clamp01(score)
  const denom = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return clamp01((centre - margin) / denom)
}

export function recordKey(agent, capability, assessor) {
  return `${agent}\u0000${capability}\u0000${assessor}`
}

export function splitKey(key) {
  const [agent, capability, assessor] = String(key).split('\u0000')
  return { agent, capability, assessor }
}

/**
 * Resolve the trust view for one (agent, capability): aggregate across
 * assessors, then add the Wilson lower bound used by routing.
 */
export function trustView(trustMap, agent, capability, prior = 0.5) {
  const records = []
  for (const [key, record] of trustMap) {
    const parts = splitKey(key)
    if (parts.agent === agent && parts.capability === capability) records.push(record)
  }
  const combined = aggregate(records, prior)
  const n = effectiveN(combined.mass)
  return {
    ...combined,
    lower: wilsonLower(combined.score, n),
    n,
    assessors: records.length,
  }
}
