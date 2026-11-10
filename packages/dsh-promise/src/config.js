/**
 * Plugin configuration. Every field has a default, so an empty `config: {}` row
 * is valid and the plugin can be disabled with one switch.
 * @module dsh-promise/config
 */
import z from '@deepseek-ai/schemastery'

const DEFAULT_ALLOWLIST = [
  '^\\s*(pnpm|npm|npx|yarn|bun)\\b',
  '^\\s*(node|deno|bun)\\b',
  '^\\s*(pytest|python3?\\s+-m\\s+pytest)\\b',
  '^\\s*(go\\s+test|cargo\\s+test|mvn\\s+test|gradle\\s+test)\\b',
  '^\\s*(tsc|eslint|ruff|mypy|golangci-lint)\\b',
  '^\\s*git\\s+(diff|status|log)\\b',
]

const DEFAULT_STRIP_PATTERNS = [
  'sk-[A-Za-z0-9]{16,}',
  'ghp_[A-Za-z0-9]{20,}',
  'github_pat_[A-Za-z0-9_]{20,}',
  'AKIA[0-9A-Z]{16}',
  'Bearer\\s+[A-Za-z0-9._-]{12,}',
  '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----',
]

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** Empty means `$DSH_HOME/promise` (defaults to `~/.dsh/promise`). */
  dataDir: z.string().default(''),
  ledger: z.object({
    snapshotEvery: z.number().step(1).min(10).default(200),
  }).default({}),
  trust: z.object({
    prior: z.number().min(0).max(1).default(0.5),
    halfLifeDays: z.number().min(1).default(14),
    explorationBonus: z.number().min(0).default(0.08),
    minEvidence: z.number().min(0).default(5),
    coldStartMass: z.number().min(0).default(5),
    probationFloor: z.number().min(0).max(1).default(0.45),
    probationRecovery: z.number().step(1).min(1).default(3),
  }).default({}),
  assessment: z.object({
    defaultLevel: z.number().step(1).min(0).max(3).default(1),
    sampleRate: z.number().min(0).max(1).default(0.15),
    maxJevCallsPerTurn: z.number().step(1).min(0).default(2),
    passThreshold: z.number().min(0).max(1).default(0.7),
    claimThreshold: z.number().min(0).max(1).default(0.6),
    failThreshold: z.number().min(0).max(1).default(0.3),
    /** Above this the answer is stable enough not to resample. */
    boundaryHigh: z.number().min(0).max(1).default(0.85),
    resample: z.boolean().default(true),
    maxStateBytes: z.number().min(1024).default(24_576),
    truncateToBytes: z.number().min(512).default(16_384),
  }).default({}),
  jev: z.object({
    enabled: z.boolean().default(true),
    baseUrl: z.string().default('https://api.typesafe.ai/v1/systemone').volatile(),
    apiKeyEnv: z.string().default('TYPESAFE_API_KEY'),
    /** Write-only secret; the settings UI never receives the stored value. */
    apiKey: z.string().role('secret').default('').volatile(),
    model: z.string().default('jev-1.14.0').volatile(),
    timeoutMs: z.number().min(1000).default(20_000),
  }).default({}),
  checks: z.object({
    /** Model-declared shell commands stay inert unless the operator opts in. */
    allowModelDeclared: z.boolean().default(false),
    allowlist: z.array(z.string()).default(DEFAULT_ALLOWLIST),
    timeoutMs: z.number().min(1000).default(600_000),
    /** Auto-settlement at turn end does not run host checks by default (cost/side effects). */
    runOnAuto: z.boolean().default(false),
  }).default({}),
  routing: z.object({
    weights: z.object({
      trust: z.number().min(0).max(1).default(0.55),
      qos: z.number().min(0).max(1).default(0.25),
      cost: z.number().min(0).max(1).default(0.1),
      explore: z.number().min(0).max(1).default(0.1),
    }).default({}),
  }).default({}),
  attribution: z.object({
    signalWeight: z.number().min(0).max(1).default(0.5),
  }).default({}),
  redaction: z.object({
    enabled: z.boolean().default(true),
    stripPatterns: z.array(z.string()).default(DEFAULT_STRIP_PATTERNS),
  }).default({}),
})
