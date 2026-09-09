import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { enumerateInstances } from '@/lib/research/signal-instances'

// Synthetic fixture mirroring the 2026-08-27 structure: 6 filled, 3 aborted,
// 1 replacement candidate (CRWD:bos), YYGH the off-high removal.
const filled = (setupId: string, symbol: string) => ({ setupId, symbol, entryFilledAt: 1 })
const aborted = (setupId: string, symbol: string) => ({ setupId, symbol, entryFilledAt: null })

const trades = [
  filled('NVDL:hod_break:36.37', 'NVDL'),
  filled('WKSP:break_of_structure:0.59', 'WKSP'),
  filled('YYGH:break_of_structure:1.86', 'YYGH'),
  filled('CRWD:opening_drive:211.67', 'CRWD'),
  filled('CRM:opening_drive:235.03', 'CRM'),
  filled('FWDI:opening_range_break:6.71', 'FWDI'),
  aborted('OKTA:break_of_structure:161.60', 'OKTA'),
  aborted('DAIC:opening_drive:5.05', 'DAIC'),
  aborted('CYPH:opening_drive:1.76', 'CYPH'),
]
const events = [
  { event: 'entry_blocked', setupId: 'CRE:break_of_structure:5.48', symbol: 'CRE', reason: 'max premarket trades reached (3)' },
  { event: 'entry_blocked', setupId: 'CRWD:break_of_structure:206.70', symbol: 'CRWD', reason: 'max premarket trades reached (3)' },
  { event: 'entry_blocked', setupId: 'DG:breakout:134.88', symbol: 'DG', reason: 'max concurrent positions (3)' },
]
const shadow = {
  reshuffle: {
    DIRECT_REMOVAL: { setupIds: ['YYGH:break_of_structure:1.86'] },
    REPLACEMENT_ADMISSION: { detail: [{ setupId: 'CRWD:break_of_structure:206.70', offHighPct: -0.26, blockedFor: 'premarket' }] },
  },
}

describe('enumerateInstances — relevant signal-instance coverage denominators', () => {
  const en = enumerateInstances({ trades, events, shadow, decisions: [] })

  it('core set = 10 instances (6 filled + 3 aborted + 1 replacement)', () => {
    expect(en.coreInstanceCount).toBe(10)
    const classes = en.core.reduce<Record<string, number>>((m, i) => { m[i.primaryClass] = (m[i.primaryClass] ?? 0) + 1; return m }, {})
    expect(classes).toEqual({ filled: 6, aborted: 3, replacement_candidate: 1 })
  })

  it('core unique symbols = 9 (CRWD appears twice but counts once)', () => {
    expect(en.coreUniqueSymbols.length).toBe(9)
    expect(en.coreUniqueSymbols).toEqual(['CRM', 'CYPH', 'CRWD', 'DAIC', 'FWDI', 'NVDL', 'OKTA', 'WKSP', 'YYGH'].sort())
  })

  it('CRWD:bos is classified replacement_candidate (precedence over capacity_blocked)', () => {
    const crwdBos = en.instances.find(i => i.setupId === 'CRWD:break_of_structure:206.70')
    expect(crwdBos?.primaryClass).toBe('replacement_candidate')
    expect(crwdBos?.blockedFor).toBe('premarket')
  })

  it('YYGH filled instance is annotated offHighRemoved without leaving the filled class', () => {
    const yygh = en.instances.find(i => i.setupId === 'YYGH:break_of_structure:1.86')
    expect(yygh?.primaryClass).toBe('filled')
    expect(yygh?.offHighRemoved).toBe(true)
  })

  it('capacity_blocked (non-replacement) still enumerated in the full set', () => {
    const cre = en.instances.find(i => i.setupId === 'CRE:break_of_structure:5.48')
    expect(cre?.primaryClass).toBe('capacity_blocked')
  })
})

// Real frozen-data fixture: runs only where the 2026-08-27 files exist.
const H = homedir()
const tradesFile = join(H, '.companion-paper-trades-2026-08-27.json')
const eventsFile = join(H, '.companion-paper-events-2026-08-27.jsonl')
const shadowFile = join(process.cwd(), 'data', 'research-cache', 'shadow-offhigh', '2026-08-27.json')
const haveAll = existsSync(tradesFile) && existsSync(eventsFile) && existsSync(shadowFile)

describe.runIf(haveAll)('enumerateInstances — real 2026-08-27 artifacts', () => {
  it('reproduces the 10-instance / 9-unique-symbol core coverage denominators', () => {
    const rt = JSON.parse(readFileSync(tradesFile, 'utf8'))
    const ev = readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    const sh = JSON.parse(readFileSync(shadowFile, 'utf8'))
    const en = enumerateInstances({ trades: rt, events: ev, shadow: sh, decisions: [] })
    expect(en.coreInstanceCount).toBe(10)
    expect(en.coreUniqueSymbols.length).toBe(9)
  })
})
