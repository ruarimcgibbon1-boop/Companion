/**
 * PRODUCER PROVENANCE GUARD — fail-closed protection against a dirty runtime.
 *
 * Session 10 proved that `git HEAD` alone is insufficient provenance: HEAD showed
 * the expected frozen producer while `npx tsx` transpiled MODIFIED tracked source
 * from the working tree. A research/paper execution daemon must therefore refuse to
 * become execution authority when tracked source is dirty, unless an explicit
 * development override is set.
 *
 * Policy (design question J = option A): ANY tracked modification — staged or
 * unstaged, including deletions/renames — makes the producer dirty. UNTRACKED files
 * (e.g. `reviews/`) and git-ignored paths (e.g. `data/research-cache/`) never make
 * it dirty, because `git diff`/`git diff --cached` ignore them. There is no
 * runtime-file allowlist to silently rot.
 *
 * This module has NO trading behaviour. It reads git state and decides eligibility
 * to take execution authority; it never places orders or mutates trade/broker state.
 */
import { spawnSync } from 'child_process'

export const OVERRIDE_ENV = 'ALLOW_DIRTY_PRODUCER'

export interface ProducerProvenance {
  /** 40-hex commit SHA, or null if it could not be resolved. */
  producerHead: string | null
  /** Branch name, 'DETACHED' at a detached HEAD, or null if unknown. */
  producerBranch: string | null
  /** True if any tracked file is modified/staged/deleted/renamed. Defaults true (fail-closed bias). */
  producerDirtyTracked: boolean
  /** True if ALLOW_DIRTY_PRODUCER=1 was set. */
  producerDirtyOverride: boolean
  /** True only if repo + HEAD + cleanliness were all determinable. */
  provenanceResolved: boolean
  /** ISO-8601 startup timestamp. */
  startedAtUtc: string
}

export interface ProducerDecision {
  provenance: ProducerProvenance
  /** May the process take execution authority? */
  allowed: boolean
  /** Human-readable refusal reason, or null when allowed. */
  refuseReason: string | null
}

/** Injectable git runner so tests never depend on the Companion repo's own state. */
export type GitRunner = (args: string[]) => { status: number | null; stdout: string; stderr: string }

export function defaultGitRunner(cwd: string = process.cwd()): GitRunner {
  return (args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    // spawnSync sets .error (e.g. ENOENT: git missing) and leaves status null.
    if (r.error) return { status: null, stdout: '', stderr: String(r.error) }
    return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() }
  }
}

/**
 * Strict override: ONLY the exact string '1' enables it — matching the daemon's
 * existing env convention (DRY_RUN/PAPER_TRADE === '1'). A typo like 'yes'/'true'
 * is NOT treated as enabled, so a dirty tree still fails closed.
 */
export function overrideEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[OVERRIDE_ENV] === '1'
}

/**
 * Resolve producer provenance from git. Fail-closed: any indeterminacy →
 * provenanceResolved=false.
 *
 * `override` is passed in explicitly — this module NEVER reads the override from
 * `process.env` itself. The caller must derive it from the INHERITED launch
 * environment (before any `.env.local`/app config is loaded), so a persistent
 * `.env.local` entry can never silently enable it. Defaults to false (fail closed).
 */
export function resolveProvenance(
  git: GitRunner,
  opts: { override?: boolean; now?: () => Date } = {},
): ProducerProvenance {
  const now = opts.now ?? (() => new Date())
  const startedAtUtc = now().toISOString()
  const overrideUsed = opts.override === true
  const base: ProducerProvenance = {
    producerHead: null,
    producerBranch: null,
    producerDirtyTracked: true, // fail-closed bias until proven clean
    producerDirtyOverride: overrideUsed,
    provenanceResolved: false,
    startedAtUtc,
  }

  // Must be inside a git work tree.
  const inside = git(['rev-parse', '--is-inside-work-tree'])
  if (inside.status !== 0 || inside.stdout !== 'true') return base

  // HEAD must resolve to a real commit SHA.
  const head = git(['rev-parse', 'HEAD'])
  if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout)) return base

  const branchRes = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const producerBranch = branchRes.status === 0
    ? (branchRes.stdout === 'HEAD' ? 'DETACHED' : branchRes.stdout)
    : null

  // Cleanliness via plumbing, not text parsing. Each `--quiet` returns:
  //   0 = clean, 1 = differences, anything else = error. Untracked files never
  //   affect `git diff`, so reviews/ and ignored paths cannot make it dirty.
  const unstaged = git(['diff', '--quiet'])
  const staged = git(['diff', '--cached', '--quiet'])
  const isError = (s: number | null) => s !== 0 && s !== 1
  if (isError(unstaged.status) || isError(staged.status)) {
    // Could not determine cleanliness → unresolved (fail closed), but keep the
    // identity we did learn for the audit line.
    return { ...base, producerHead: head.stdout, producerBranch }
  }

  const producerDirtyTracked = unstaged.status === 1 || staged.status === 1
  return {
    producerHead: head.stdout,
    producerBranch,
    producerDirtyTracked,
    producerDirtyOverride: overrideUsed,
    provenanceResolved: true,
    startedAtUtc,
  }
}

/** Pure decision from provenance: fail closed on unresolved or dirty (unless overridden). */
export function decideProducer(provenance: ProducerProvenance): ProducerDecision {
  if (!provenance.provenanceResolved) {
    return {
      provenance,
      allowed: false,
      refuseReason: 'producer provenance could not be established (not a git work tree, or git/HEAD/cleanliness query failed)',
    }
  }
  if (provenance.producerDirtyTracked) {
    if (provenance.producerDirtyOverride) {
      return { provenance, allowed: true, refuseReason: null }
    }
    return { provenance, allowed: false, refuseReason: 'tracked working-tree changes present (dirty producer)' }
  }
  return { provenance, allowed: true, refuseReason: null }
}

export interface EnforceOptions {
  /** True when this process will take execution authority (e.g. PAPER_TRADE). Only then does a refusal exit. */
  requireAuthority: boolean
  /**
   * Whether the dirty-tree override is enabled. The CALLER must derive this from the
   * INHERITED launch environment (captured before `.env.local`/app config loads) — e.g.
   * `overrideEnabled(process.env)` at the very top of the entrypoint. Never let it come
   * from later-loaded application config, or an emergency override becomes a silent default.
   */
  override: boolean
  git?: GitRunner
  cwd?: string
  now?: () => Date
  log?: (...a: unknown[]) => void
  /** Injectable exit so tests observe termination without killing the runner. */
  exit?: (code: number) => void
}

/**
 * Enforce the guard at daemon startup, BEFORE any execution authority is taken.
 * Returns the resolved provenance (to be stamped into the init event). When
 * requireAuthority is true and the producer is dirty/unverifiable (without a valid
 * override), emits a loud diagnostic and exits non-zero — the executor is never
 * constructed, so no reconciliation, order, or authority declaration can occur.
 */
export function enforceProducerProvenance(opts: EnforceOptions): ProducerProvenance {
  const git = opts.git ?? defaultGitRunner(opts.cwd)
  const log = opts.log ?? console.error
  const exit = opts.exit ?? ((c: number) => process.exit(c))

  const provenance = resolveProvenance(git, { override: opts.override, now: opts.now })
  const decision = decideProducer(provenance)
  const line =
    `producer provenance · head=${provenance.producerHead ?? 'UNKNOWN'} ` +
    `branch=${provenance.producerBranch ?? 'UNKNOWN'} ` +
    `dirtyTracked=${provenance.producerDirtyTracked} ` +
    `override=${provenance.producerDirtyOverride} resolved=${provenance.provenanceResolved}`

  if (!decision.allowed && opts.requireAuthority) {
    log('╔════════════════════════════════════════════════════════════════════╗')
    log('  EXECUTION AUTHORITY REFUSED — dirty or unverifiable producer')
    log(`  reason: ${decision.refuseReason}`)
    log(`  ${line}`)
    log(`  Set ${OVERRIDE_ENV}=1 ONLY for non-authoritative development.`)
    log('  The V2 research protocol PROHIBITS this override during experiments.')
    log('╚════════════════════════════════════════════════════════════════════╝')
    exit(1)
    return provenance // reached only when a test injects a non-terminating exit
  }

  if (provenance.producerDirtyOverride && provenance.producerDirtyTracked) {
    log('╔════════════════════════════════════════════════════════════════════╗')
    log(`  WARNING: ${OVERRIDE_ENV}=1 — taking execution authority from a DIRTY producer tree`)
    log(`  ${line}`)
    log('  This is prohibited under the V2 research protocol; use for development only.')
    log('╚════════════════════════════════════════════════════════════════════╝')
  } else if (!decision.allowed) {
    // Not taking authority (requireAuthority=false) but provenance is dirty/unresolved.
    log(`NOTE: producer not clean but execution authority not requested — ${decision.refuseReason}`)
    log(line)
  } else {
    log(line)
  }
  return provenance
}
