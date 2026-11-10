/**
 * Verdict algebra. Rules and executable checks can veto; semantic answers only
 * adjust. The engine, not the model, turns evidence into a three-valued verdict.
 * @module dsh-promise/verdict
 */
import { clamp01 } from './util.js'

/**
 * @param {object} input
 * @param {Array<{id:string, hard?:boolean, ok:boolean, detail?:string}>} [input.rules]
 * @param {null|object} [input.semantic] mapped Jev answers
 * @param {{pass:number, claim:number, fail:number}} [input.thresholds]
 * @param {boolean} [input.truncated]
 * @returns {{verdict:'fulfilled'|'violated'|'undetermined', confidence:number, failureMode:string, rationale:string, hardFailures:string[]}}
 */
export function decide(input = {}) {
  const rules = Array.isArray(input.rules) ? input.rules : []
  const thresholds = {
    pass: input.thresholds?.pass ?? 0.7,
    claim: input.thresholds?.claim ?? 0.6,
    fail: input.thresholds?.fail ?? 0.3,
    minConfidence: input.thresholds?.minConfidence ?? 0,
  }
  const hardFailures = rules.filter((rule) => rule.hard !== false && rule.ok === false).map((rule) => rule.id)
  const hardRules = rules.filter((rule) => rule.hard !== false)

  if (hardFailures.length > 0) {
    return {
      verdict: 'violated',
      confidence: 1,
      failureMode: `rule:${hardFailures[0]}`,
      rationale: `hard rule failed: ${hardFailures.join(', ')}`,
      hardFailures,
    }
  }

  const semantic = input.semantic
  if (!semantic || semantic.addressesRequest == null) {
    if (hardRules.length === 0) {
      return {
        verdict: 'undetermined',
        confidence: 0,
        failureMode: 'none',
        rationale: 'no checks or semantic evidence were available',
        hardFailures,
      }
    }
    return {
      verdict: 'fulfilled',
      confidence: 0.6,
      failureMode: 'none',
      rationale: `all ${hardRules.length} hard rule(s) passed; requirement fit was not assessed`,
      hardFailures,
    }
  }

  const p = clamp01(semantic.addressesRequest)
  const contradicted = clamp01(semantic.claimsContradicted ?? 0)
  let confidence = clamp01(semantic.confidence ?? 0.5)
  if (input.truncated || semantic.unstable) confidence = Math.min(confidence, 0.5)

  if (confidence < thresholds.minConfidence) {
    return {
      verdict: 'undetermined',
      confidence,
      failureMode: semantic.failureMode ?? 'none',
      rationale: `semantic confidence ${confidence.toFixed(2)} is below the floor ${thresholds.minConfidence}`,
      hardFailures,
    }
  }

  const contradictedClaim = contradicted >= 0.7
  let verdict
  let rationale
  if (semantic.unstable) {
    verdict = 'undetermined'
    rationale = `verdict unstable across samples (p=${p.toFixed(2)})`
  } else if (p >= thresholds.pass && contradicted <= thresholds.fail) {
    verdict = 'fulfilled'
    rationale = `addresses_request p=${p.toFixed(2)} ≥ ${thresholds.pass}; claims contradicted p=${contradicted.toFixed(2)}`
  } else if (p <= thresholds.fail || contradictedClaim) {
    verdict = 'violated'
    rationale = contradictedClaim
      ? `the agent's claims are contradicted by evidence (p=${contradicted.toFixed(2)})`
      : `addresses_request p=${p.toFixed(2)} ≤ ${thresholds.fail}`
  } else {
    verdict = 'undetermined'
    rationale = `addresses_request p=${p.toFixed(2)} sits between ${thresholds.fail} and ${thresholds.pass}`
  }

  return {
    verdict,
    confidence: verdict === 'undetermined' ? Math.min(confidence, 0.5) : confidence,
    failureMode: contradictedClaim ? 'process' : semantic.failureMode ?? 'none',
    rationale,
    hardFailures,
  }
}

/**
 * Composite 0..1 score used as trust evidence when the verdict is not
 * undetermined. Relative performance defaults to neutral until a baseline
 * exists, so a missing baseline cannot silently punish an agent.
 */
export function compositeScore(layers) {
  const absolute = clamp01(layers.absolute ?? 0.5)
  const relative = clamp01(layers.relative ?? 0.5)
  const process = clamp01(layers.process ?? 0.5)
  return clamp01(0.45 * absolute + 0.3 * relative + 0.25 * process)
}

export function verdictScore(verdict, layers) {
  if (verdict === 'violated') return Math.min(compositeScore(layers), 0.3)
  if (verdict === 'fulfilled') return Math.max(compositeScore(layers), 0.7)
  return compositeScore(layers)
}
