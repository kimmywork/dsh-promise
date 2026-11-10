/**
 * Policy identity: the stable configuration that produces an agent's behavior.
 * The per-task prompt is deliberately NOT part of this hash; only the system
 * prompt, tools, model, preset, and the promise contract are.
 * @module dsh-promise/policy
 */
import { canonicalJson, sha256 } from './util.js'

const FIELDS = [
  'agentPreset',
  'provider',
  'model',
  'reasoningEffort',
  'systemPromptHash',
  'toolsHash',
  'contractHash',
]

function field(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Build a deterministic policy record. Unknown fields stay null; a record with
 * no known field is `legacy`, which keeps old ledger evidence auditable.
 * @param {object} [input]
 * @returns {{id:string, agentPreset:string|null, provider:string|null, model:string|null, reasoningEffort:string|null, systemPromptHash:string|null, toolsHash:string|null, contractHash:string|null}}
 */
export function buildPolicy(input = {}) {
  const fields = {}
  for (const name of FIELDS) fields[name] = field(input[name])
  const known = FIELDS.some((name) => fields[name] !== null)
  return {
    id: known ? `p_${sha256(canonicalJson(fields)).slice(0, 12)}` : 'legacy',
    ...fields,
  }
}

/**
 * Hash the falsifiable contract, not the task prompt. Re-declaring the same
 * statement/rules yields the same hash; changing any of them creates a new
 * policy lineage.
 * @param {object} promise
 * @returns {string}
 */
export function contractHash(promise = {}) {
  return sha256(canonicalJson({
    statement: promise.statement ?? '',
    qos: promise.qos ?? {},
    requirements: promise.requirements ?? [],
    rules: promise.rules ?? [],
    assessment: promise.assessment ?? {},
  })).slice(0, 12)
}

/** Human-readable one-line policy label for prompts, cards and inspect output. */
export function policyLabel(policy) {
  if (!policy || policy.id === 'legacy') return 'legacy policy'
  const parts = []
  if (policy.model) parts.push(policy.model)
  if (policy.agentPreset) parts.push(policy.agentPreset)
  if (policy.reasoningEffort) parts.push(`effort:${policy.reasoningEffort}`)
  return parts.length > 0 ? parts.join(' · ') : policy.id
}
