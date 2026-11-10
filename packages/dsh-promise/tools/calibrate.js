#!/usr/bin/env node
/**
 * Calibration harness: does Jev (or any configured assessor) agree with labelled
 * verdicts? This is the gate that decides whether semantic evidence may move
 * trust, so it is deliberately a separate, offline script.
 *
 * Input: JSONL, one case per line:
 *   {
 *     "id": "case-1",
 *     "capability": "code.change",
 *     "statement": "the promise text",           (optional)
 *     "requirements": [{ "id": "...", "text": "..." }],  (optional)
 *     "request": "what was asked",
 *     "output": "what was produced",
 *     "label": { "verdict": "fulfilled" | "violated" | "undetermined" },
 *     "labelLayers": { "absolute": 0.8 }          (optional)
 *   }
 *
 * Usage:
 *   TYPESAFE_API_KEY=... node tools/calibrate.js --cases cases.jsonl
 *   node tools/calibrate.js --cases cases.jsonl --model jev-1.14.0 --limit 50
 */
import fs from 'node:fs'
import { JevClient } from '../src/jev.js'
import { runSemantic } from '../src/assess.js'
import { decide } from '../src/verdict.js'

function parseArgs(argv) {
  const args = { cases: '', model: 'jev-1.14.0', limit: 0, out: '', gate: true, minKappa: 0.6, maxFalsePass: 0.05, apiKeyEnv: 'TYPESAFE_API_KEY' }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--cases') { args.cases = value; i += 1 }
    else if (flag === '--model') { args.model = value; i += 1 }
    else if (flag === '--limit') { args.limit = Number(value); i += 1 }
    else if (flag === '--out') { args.out = value; i += 1 }
    else if (flag === '--api-key-env') { args.apiKeyEnv = value; i += 1 }
    else if (flag === '--no-gate') { args.gate = false }
    else if (flag === '--min-kappa') { args.minKappa = Number(value); i += 1 }
    else if (flag === '--max-false-pass') { args.maxFalsePass = Number(value); i += 1 }
    else if (flag === '--help' || flag === '-h') { args.help = true }
  }
  return args
}

function usage() {
  console.log(`usage: node tools/calibrate.js --cases <cases.jsonl> [--model jev-1.14.0] [--limit N]
       [--out report.json] [--no-gate] [--min-kappa 0.6] [--max-false-pass 0.05]

environment:
  TYPESAFE_API_KEY (override the variable name with --api-key-env)`)
}

function cohenKappa(pairs, classes) {
  const n = pairs.length
  if (n === 0) return 0
  let agree = 0
  const gold = Object.fromEntries(classes.map((c) => [c, 0]))
  const pred = Object.fromEntries(classes.map((c) => [c, 0]))
  for (const [truth, guess] of pairs) {
    if (truth === guess) agree += 1
    gold[truth] = (gold[truth] ?? 0) + 1
    pred[guess] = (pred[guess] ?? 0) + 1
  }
  const po = agree / n
  let pe = 0
  for (const c of classes) pe += ((gold[c] ?? 0) / n) * ((pred[c] ?? 0) / n)
  if (pe >= 1) return 1
  return (po - pe) / (1 - pe)
}

function buildObservation(evidence) {
  const rules = []
  const checks = []
  for (const item of Array.isArray(evidence) ? evidence : []) {
    const entry = { id: String(item.id ?? 'e'), ok: item.ok !== false, detail: String(item.detail ?? '') }
    if (item.kind === 'rule') rules.push(entry)
    else checks.push(entry)
  }
  return { rules, checks, toolResults: [], durationMs: 0 }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.cases) {
    usage()
    process.exit(args.help ? 0 : 2)
  }
  const apiKey = process.env[args.apiKeyEnv] ?? ''
  if (!apiKey) {
    console.error(`missing ${args.apiKeyEnv}`)
    process.exit(2)
  }
  const client = new JevClient({ baseUrl: 'https://api.typesafe.ai/v1/systemone', apiKey, model: args.model, timeoutMs: 30_000 })
  const raw = fs.readFileSync(args.cases, 'utf8').split('\n').filter((line) => line.trim() !== '')
  const cases = raw.map((line) => JSON.parse(line)).slice(0, args.limit > 0 ? args.limit : undefined)

  const records = []
  for (const [index, item] of cases.entries()) {
    const truth = item.label?.verdict
    if (!truth) {
      console.error(`case ${item.id ?? index}: missing label.verdict, skipped`)
      continue
    }
    const promise = {
      agent: 'calibration',
      capability: item.capability ?? 'unknown.capability',
      statement: item.statement ?? 'calibration case',
      qos: item.qos ?? {},
      requirements: item.requirements ?? [],
    }
    try {
      const result = await runSemantic({
        client,
        promise,
        job: { request: item.request ?? '', constraints: {} },
        observation: buildObservation(item.evidence),
        output: { text: item.output ?? '' },
        config: { maxStateBytes: 24_576, truncateToBytes: 16_384, resample: true, passThreshold: 0.7, failThreshold: 0.3, boundaryHigh: 0.85 },
      })
      const verdict = decide({ rules: [], semantic: result.semantic, thresholds: { pass: 0.7, claim: 0.6, fail: 0.3 }, truncated: result.semantic.truncated })
      records.push({
        id: item.id ?? String(index),
        capability: promise.capability,
        truth,
        predicted: verdict.verdict,
        confidence: verdict.confidence,
        addressesRequest: result.semantic.addressesRequest,
        absolute: result.semantic.absolute,
        rationale: verdict.rationale,
      })
      process.stderr.write(`[${index + 1}/${cases.length}] ${item.id ?? index} ${truth} → ${verdict.verdict}\n`)
    } catch (error) {
      console.error(`case ${item.id ?? index}: assessment failed: ${error.message}`)
    }
  }

  const classes = ['fulfilled', 'violated', 'undetermined']
  const pairs = records.map((record) => [record.truth, record.predicted])
  const evaluate = (subset) => {
    const n = subset.length
    const falsePass = subset.filter((record) => record.truth === 'violated' && record.predicted === 'fulfilled').length
    const falseFail = subset.filter((record) => record.truth === 'fulfilled' && record.predicted === 'violated').length
    const correct = subset.filter((record) => record.truth === record.predicted).length
    const confidenceError = n > 0
      ? subset.reduce((sum, record) => sum + Math.abs(record.confidence - (record.truth === record.predicted ? 1 : 0)), 0) / n
      : 0
    return {
      n,
      accuracy: n > 0 ? correct / n : 0,
      falsePass: n > 0 ? falsePass / n : 0,
      falseFail: n > 0 ? falseFail / n : 0,
      confidenceError: Number(confidenceError.toFixed(3)),
    }
  }

  const byCapability = {}
  for (const record of records) {
    byCapability[record.capability] ??= []
    byCapability[record.capability].push(record)
  }

  const report = {
    model: args.model,
    cases: records.length,
    overall: { ...evaluate(records), kappa: Number(cohenKappa(pairs, classes).toFixed(3)) },
    byCapability: Object.fromEntries(Object.entries(byCapability).map(([capability, rows]) => [capability, evaluate(rows)])),
    gate: null,
    records,
  }
  const passed = report.overall.falsePass <= args.maxFalsePass && report.overall.kappa >= args.minKappa
  report.gate = {
    passed,
    requires: { maxFalsePass: args.maxFalsePass, minKappa: args.minKappa },
    meaning: passed
      ? 'semantic evidence may update trust at L2/L3'
      : 'keep semantic evidence advisory; do not let it move trust until calibrated',
  }

  console.log(`cases ${report.cases}`)
  console.log(`overall accuracy ${report.overall.accuracy.toFixed(3)} · kappa ${report.overall.kappa} · false-pass ${(report.overall.falsePass * 100).toFixed(1)}% · false-fail ${(report.overall.falseFail * 100).toFixed(1)}% · confidence error ${report.overall.confidenceError}`)
  for (const [capability, row] of Object.entries(report.byCapability)) {
    console.log(`  ${capability.padEnd(24)} n=${row.n} acc=${row.accuracy.toFixed(3)} false-pass=${(row.falsePass * 100).toFixed(1)}%`)
  }
  console.log(`gate: ${passed ? 'PASS' : 'FAIL'} — ${report.gate.meaning}`)
  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2))
    console.log(`report written to ${args.out}`)
  }
  if (args.gate && !passed) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
