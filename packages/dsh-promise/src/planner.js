/**
 * Deterministic assessment-level planning (L0-L3). The model never gets to pick
 * its own scrutiny level; risk, reversibility, value, evidence mass and budget
 * decide it, and every decision carries the reasons behind it.
 * @module dsh-promise/planner
 */
import { clamp } from './util.js'

/**
 * @param {object} input
 * @param {number} [input.riskTier] 0 low, 1 medium, 2 high, 3 irreversible
 * @param {boolean} [input.reversible]
 * @param {'low'|'high'} [input.value]
 * @param {number} [input.mass] decayed evidence mass for the chosen promise
 * @param {'L0'|'L1'|'L2'|'L3'|'auto'} [input.declaredPolicy]
 * @param {boolean} [input.budgetExhausted]
 * @param {number} [input.coldStartMass]
 * @param {number} [input.defaultLevel]
 * @returns {{level:number, reasons:string[]}}
 */
export function planLevel(input = {}, { coldStartMass = 5, defaultLevel = 1 } = {}) {
  const reasons = []
  const hasRisk = Number.isInteger(input.riskTier)
  let level = hasRisk ? clamp(input.riskTier, 0, 3) : clamp(defaultLevel, 0, 3)
  if (hasRisk) reasons.push(`risk tier ${input.riskTier}`)

  if (input.reversible === false) {
    level = 3
    reasons.push('irreversible action requires L3')
  }

  if (input.value === 'high') {
    if (level < 2) {
      level = 2
      reasons.push('high-value output requires L2+')
    }
  }

  const mass = Number(input.mass ?? 0)
  if (mass < coldStartMass) {
    if (level < 3) {
      level += 1
      reasons.push(`cold start (mass ${mass.toFixed(1)} < ${coldStartMass}) raises scrutiny`)
    }
  }

  const declared = String(input.declaredPolicy ?? 'auto').toUpperCase()
  if (/^L[0-3]$/.test(declared)) {
    const declaredLevel = Number(declared.slice(1))
    if (declaredLevel > level) {
      level = declaredLevel
      reasons.push(`promise declares ${declared}`)
    }
  }

  if (input.budgetExhausted && level > 1) {
    level = 1
    reasons.push('assessment budget exhausted; degraded to L1')
  }

  level = clamp(level, 0, 3)
  if (reasons.length === 0) reasons.push('default level')
  return { level, reasons }
}

/** Deterministic sampling decision for L2, injectable random for tests. */
export function shouldSample(sampleRate, random = Math.random) {
  if (!(sampleRate > 0)) return false
  if (sampleRate >= 1) return true
  return random() < sampleRate
}
