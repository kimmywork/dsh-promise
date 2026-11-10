/**
 * L1 structural rules evaluated against an observation (changed files, tool
 * outcomes, output text, latency). Rules are cheap, deterministic, and can veto.
 * @module dsh-promise/rules
 */
import { matchGlobs } from './util.js'

function makeRule(rule, ok, detail) {
  return { id: rule.id ?? rule.kind ?? 'rule', kind: rule.kind, hard: rule.hard !== false, ok, detail }
}

/**
 * @param {object} promise promise record
 * @param {object} observation collected observation
 * @returns {Array<{id:string, kind:string, hard:boolean, ok:boolean, detail:string}>}
 */
export function evaluateRules(promise, observation) {
  const rules = Array.isArray(promise.rules) ? promise.rules : []
  const results = []
  const changedFiles = Array.isArray(observation.changedFiles) ? observation.changedFiles : []
  const outputText = String(observation.outputText ?? '')
  const toolResults = Array.isArray(observation.toolResults) ? observation.toolResults : []

  for (const rule of rules) {
    switch (rule.kind) {
      case 'files-within': {
        const globs = rule.globs ?? []
        const offenders = changedFiles.filter((file) => !matchGlobs(file, globs))
        results.push(makeRule(rule, offenders.length === 0, offenders.length === 0 ? `${changedFiles.length} file(s) within scope` : `out of scope: ${offenders.slice(0, 3).join(', ')}`))
        break
      }
      case 'diff-touches': {
        const globs = rule.globs ?? []
        const hits = changedFiles.filter((file) => matchGlobs(file, globs))
        results.push(makeRule(rule, hits.length > 0, hits.length > 0 ? `touched ${hits.slice(0, 3).join(', ')}` : 'no changed file matched the required globs'))
        break
      }
      case 'max-files': {
        const max = Number(rule.max ?? 10)
        results.push(makeRule(rule, changedFiles.length <= max, `${changedFiles.length} changed file(s), max ${max}`))
        break
      }
      case 'no-match': {
        let matched = false
        try {
          matched = new RegExp(String(rule.pattern ?? ''), 'm').test(outputText)
        } catch {
          matched = false
        }
        results.push(makeRule(rule, !matched, matched ? 'output matched a forbidden pattern' : 'no forbidden pattern'))
        break
      }
      case 'required-sections': {
        const headings = Array.isArray(rule.headings) ? rule.headings : []
        const missing = headings.filter((heading) => !outputText.toLowerCase().includes(String(heading).toLowerCase()))
        results.push(makeRule(rule, missing.length === 0, missing.length === 0 ? 'all required sections present' : `missing: ${missing.join(', ')}`))
        break
      }
      case 'json-schema': {
        let parsed
        let ok = false
        let detail = 'output is not valid JSON'
        try {
          parsed = JSON.parse(outputText)
          const required = Array.isArray(rule.required) ? rule.required : []
          const missing = required.filter((key) => !(parsed && typeof parsed === 'object' && key in parsed))
          ok = missing.length === 0
          detail = ok ? 'JSON parses and has required keys' : `missing keys: ${missing.join(', ')}`
        } catch {
          ok = false
        }
        results.push(makeRule(rule, ok, detail))
        break
      }
      case 'tool-ok': {
        const names = Array.isArray(rule.names) ? rule.names : []
        const failed = toolResults.filter((result) => names.includes(result.name) && result.ok === false)
        results.push(makeRule(rule, failed.length === 0, failed.length === 0 ? 'required tools succeeded' : `${failed.length} required tool call(s) failed`))
        break
      }
      case 'max-latency': {
        const maxMs = Number(rule.maxMs ?? Number.MAX_SAFE_INTEGER)
        const latency = Number(observation.durationMs ?? 0)
        results.push(makeRule(rule, latency <= maxMs, `${latency}ms, max ${maxMs}ms`))
        break
      }
      case 'min-bytes': {
        const min = Number(rule.min ?? 1)
        const bytes = Buffer.byteLength(outputText, 'utf8')
        results.push(makeRule(rule, bytes >= min, `${bytes} bytes, min ${min}`))
        break
      }
      default:
        results.push(makeRule(rule, true, `unknown rule kind "${rule.kind}" ignored`))
    }
  }
  return results
}
