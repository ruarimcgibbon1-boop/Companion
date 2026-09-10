/**
 * MIKE'S STRATEGY — persistence (SEPARATE from REGULAR).
 *
 * Mike writes ONLY to its own files, never to the REGULAR decision/event/trade logs,
 * so no Mike record can contaminate REGULAR aggregates. Every persisted row carries
 * `strategy: 'mike'`. ET-day rotation reuses the REGULAR store's pure date helper.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { etDayKey } from '@/lib/execution/store'
import { MIKE_STRATEGY, type MikeCandidate, type MikeShadowOutcome } from './types'
import type { MikeStoreState, MikeEvent } from './driver'

export function mikeCandidatesFile(day = etDayKey()): string {
  return join(homedir(), `.companion-mike-candidates-${day}.jsonl`)
}
export function mikeShadowFile(day = etDayKey()): string {
  return join(homedir(), `.companion-mike-shadow-${day}.jsonl`)
}
/** Full lifecycle snapshot for restart recovery — one JSON per ET day. */
export function mikeStateFile(day = etDayKey()): string {
  return join(homedir(), `.companion-mike-state-${day}.json`)
}
/** Append-only, deduped lifecycle events (state changes + material evidence changes). */
export function mikeEventsFile(day = etDayKey()): string {
  return join(homedir(), `.companion-mike-events-${day}.jsonl`)
}

export function loadMikeState(day = etDayKey()): MikeStoreState {
  try {
    const p = mikeStateFile(day)
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) as MikeStoreState
  } catch { /* corrupt/missing → fresh */ }
  return { candidates: [] }
}
export function saveMikeState(state: MikeStoreState, day = etDayKey()): void {
  try { writeFileSync(mikeStateFile(day), JSON.stringify(state)) } catch { /* best-effort */ }
}
export function appendMikeEvent(event: MikeEvent, now: number = event.ts): void {
  try { appendFileSync(mikeEventsFile(etDayKey(now)), JSON.stringify(event) + '\n') } catch { /* best-effort */ }
}

/** A persisted shadow row — links a candidate to its evidence-only outcome. */
export interface MikeShadowRow {
  strategy: typeof MIKE_STRATEGY
  ts: string
  symbol: string
  breakoutLevel: number | null
  state: MikeCandidate['state']
  outcome: MikeCandidate['outcome']
  vetoReason: string | null
  shadow: MikeShadowOutcome
}

export function appendMikeCandidate(c: MikeCandidate, now: number = c.now): void {
  try {
    appendFileSync(mikeCandidatesFile(etDayKey(now)), JSON.stringify({ ts: new Date(now).toISOString(), ...c }) + '\n')
  } catch { /* audit trail is best-effort */ }
}

export function appendMikeShadow(row: MikeShadowRow, now: number = Date.now()): void {
  try {
    appendFileSync(mikeShadowFile(etDayKey(now)), JSON.stringify(row) + '\n')
  } catch { /* best-effort */ }
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) as T } catch { return null } })
    .filter((x): x is T => x !== null)
}

export function readMikeCandidates(day = etDayKey()): MikeCandidate[] {
  return readJsonl<MikeCandidate>(mikeCandidatesFile(day))
}
export function readMikeShadow(day = etDayKey()): MikeShadowRow[] {
  return readJsonl<MikeShadowRow>(mikeShadowFile(day))
}
