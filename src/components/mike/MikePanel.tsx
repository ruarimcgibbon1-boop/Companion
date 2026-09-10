/**
 * MIKE'S STRATEGY — minimal, visually-distinct inspection panel (v0.2).
 *
 * Presentational only. Renders one MikeCandidate so a ticker's Mike status is
 * visible at a glance, kept deliberately separate from the REGULAR setup UI. Not
 * wired into the main page yet (v0.2 scope: "add only enough UI to inspect safely").
 */
import type { MikeCandidate, MikeState } from '@/lib/mike/types'

function px(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '—'
  const d = Math.abs(n) < 1 ? 3 : 2
  return `$${n.toFixed(d)}`
}

const STATE_LABEL: Record<MikeState, string> = {
  SCANNED: 'Scanned',
  APPROACHING_HIGH: 'Approaching high',
  BREAKING: 'Breaking',
  WAITING_5M_ACCEPTANCE: 'Waiting 5m acceptance',
  ACCEPTED: 'Accepted',
  LOADING: 'Loading',
  TRIGGERED: 'Triggered',
  MANAGING: 'Managing',
  VETOED: 'Vetoed',
  EXPIRED: 'Expired',
}

const LEVEL_LABEL: Record<NonNullable<MikeCandidate['breakoutLevel']>['type'], string> = {
  prev_day_high: 'Prev-day-high continuation',
  premarket_high: 'Premarket-high continuation',
  hod: 'HOD continuation',
  twenty_day_high: '20-day-high continuation',
  resistance: 'Resistance-break continuation',
}

export function MikePanel({ candidate }: { candidate: MikeCandidate }) {
  const c = candidate
  const isVeto = c.state === 'VETOED' || c.state === 'EXPIRED' || c.veto != null
  const subtitle = c.breakoutLevel ? LEVEL_LABEL[c.breakoutLevel.type] : 'No level in play'

  return (
    <div
      data-testid="mike-panel"
      data-mike-state={c.state}
      style={{
        border: '1px solid #7c3aed',
        borderLeft: '4px solid #7c3aed',
        borderRadius: 8,
        padding: '10px 12px',
        background: 'rgba(124,58,237,0.06)',
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 340,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontWeight: 800, letterSpacing: 1, color: '#7c3aed' }}>MIKE</span>
        <span style={{ fontSize: 12, opacity: 0.75 }}>{subtitle}</span>
      </div>

      <div data-testid="mike-state" style={{ fontSize: 16, fontWeight: 700, marginTop: 4, color: isVeto ? '#b91c1c' : undefined }}>
        {isVeto && c.veto ? `VETOED — ${c.veto.reason}` : STATE_LABEL[c.state].toUpperCase()}
      </div>

      {c.breakoutLevel && (
        <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
          <div>Break level {px(c.breakoutLevel.price)}</div>
          {c.loadingZone && (
            <div>Loading zone {px(c.loadingZone.low)}–{px(c.loadingZone.high)}</div>
          )}
          <div data-testid="mike-confirmations">
            Supporting confirmations {c.supportingCount}/6
          </div>
          {c.tradePlan && (
            <div style={{ marginTop: 4, opacity: 0.85 }}>
              Entry {px(c.tradePlan.entry)} · stop {px(c.tradePlan.stop.price)} ({c.tradePlan.stop.ref})
            </div>
          )}
        </div>
      )}
    </div>
  )
}
