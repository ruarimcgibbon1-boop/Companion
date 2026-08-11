/**
 * Alpaca paper-trading broker.
 *
 * Talks to the paper REST API directly (no SDK — the surface we need is six
 * endpoints, and a dependency-free client is one less thing to pin). Every
 * numeric field Alpaca returns is a *string*; all of that coercion is contained
 * here so nothing downstream ever sees `"12.3400"` where it expects a number.
 *
 * Extended-hours rules, which shape the whole executor:
 *   • extended_hours:true requires type=limit AND time_in_force=day
 *   • stop orders and bracket/OCO classes are rejected outside 09:30–16:00
 * So a premarket position cannot carry a resting broker-side stop. The executor
 * covers that window with its polled exit loop and places the protective stop
 * once regular hours open.
 *
 * Env: ALPACA_KEY_ID, ALPACA_SECRET_KEY, optional ALPACA_BASE_URL.
 */
import type {
  Broker, BrokerAccount, BrokerOrder, BrokerOrderStatus, BrokerPosition,
  AssetInfo, LimitOrderRequest, StopOrderRequest,
} from './types'

const PAPER_BASE = 'https://paper-api.alpaca.markets'

/** Alpaca rejects prices finer than a penny above $1, or 1/100th of a cent below. */
export function roundToTick(price: number): number {
  return price >= 1
    ? Math.round(price * 100) / 100
    : Math.round(price * 10_000) / 10_000
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : 0
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

/**
 * Alpaca's status vocabulary is far wider than anything the executor should
 * branch on. Collapse it to the outcomes that change what we do next; an
 * unrecognised status maps to 'unknown' and is treated as still-working rather
 * than silently assumed dead.
 */
export function mapStatus(raw: string): BrokerOrderStatus {
  switch (raw) {
    case 'new': case 'accepted': case 'pending_new': case 'accepted_for_bidding':
    case 'held': case 'calculated': case 'replaced': case 'pending_replace':
      return 'open'
    case 'partially_filled': return 'partially_filled'
    case 'filled': return 'filled'
    case 'canceled': case 'pending_cancel': return 'canceled'
    case 'expired': case 'done_for_day': return 'expired'
    case 'rejected': case 'suspended': case 'stopped': return 'rejected'
    default: return 'unknown'
  }
}

interface RawOrder {
  id: string
  client_order_id?: string | null
  symbol: string
  side: string
  status: string
  qty?: string | null
  filled_qty?: string | null
  filled_avg_price?: string | null
  limit_price?: string | null
  submitted_at?: string | null
}

function toOrder(raw: RawOrder): BrokerOrder {
  return {
    id: raw.id,
    clientOrderId: raw.client_order_id ?? null,
    symbol: raw.symbol,
    side: raw.side === 'sell' ? 'sell' : 'buy',
    status: mapStatus(raw.status),
    qty: num(raw.qty),
    filledQty: num(raw.filled_qty),
    filledAvgPrice: numOrNull(raw.filled_avg_price),
    limitPrice: numOrNull(raw.limit_price),
    submittedAt: raw.submitted_at ? new Date(raw.submitted_at).getTime() : Date.now(),
    rejectReason: null,
  }
}

function toPosition(p: Record<string, unknown>): BrokerPosition {
  const qty = num(p.qty)
  return {
    symbol: String(p.symbol),
    qty,
    // Older payloads omit qty_available; assume nothing is held rather than
    // reporting zero free shares and stalling every sell behind the wait loop.
    qtyAvailable: p.qty_available == null ? qty : num(p.qty_available),
    avgEntryPrice: num(p.avg_entry_price),
    currentPrice: numOrNull(p.current_price),
    unrealizedPl: num(p.unrealized_pl),
  }
}

export class AlpacaBrokerError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message)
    this.name = 'AlpacaBrokerError'
  }
}

export class AlpacaBroker implements Broker {
  readonly name = 'alpaca-paper'
  private readonly base: string
  private readonly headers: Record<string, string>

  constructor(opts?: { keyId?: string; secretKey?: string; baseUrl?: string }) {
    const keyId = opts?.keyId ?? process.env.ALPACA_KEY_ID
    const secretKey = opts?.secretKey ?? process.env.ALPACA_SECRET_KEY
    if (!keyId || !secretKey) {
      throw new Error('ALPACA_KEY_ID / ALPACA_SECRET_KEY missing — add them to .env.local')
    }
    this.base = (opts?.baseUrl ?? process.env.ALPACA_BASE_URL ?? PAPER_BASE).replace(/\/$/, '')
    // Guard rail: this module is the paper path. Pointing it at the live host is a
    // one-line env change, so refuse it outright rather than trust the operator's typing.
    if (/(^|\/\/)api\.alpaca\.markets/.test(this.base)) {
      throw new Error(`refusing to run against the live Alpaca endpoint (${this.base}) — paper only`)
    }
    this.headers = {
      'APCA-API-KEY-ID': keyId,
      'APCA-API-SECRET-KEY': secretKey,
      'Content-Type': 'application/json',
    }
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { ...init, headers: this.headers })
    const text = await res.text()
    if (!res.ok) {
      throw new AlpacaBrokerError(`Alpaca ${init?.method ?? 'GET'} ${path} → ${res.status}: ${text}`, res.status, text)
    }
    return (text ? JSON.parse(text) : null) as T
  }

  async getAccount(): Promise<BrokerAccount> {
    const a = await this.req<Record<string, unknown>>('/v2/account')
    return {
      equity: num(a.equity),
      cash: num(a.cash),
      buyingPower: num(a.buying_power),
      daytradeCount: num(a.daytrade_count),
      blocked: a.trading_blocked === true || a.account_blocked === true,
    }
  }

  /**
   * Tradability check. Alpaca lists no OTC/pink-sheet names and flags some
   * low-float movers non-tradable outright — on this strategy that is a real
   * miss rate, not an edge case, so the executor records the skip rather than
   * letting the order fail at submit time.
   */
  async getAsset(symbol: string): Promise<AssetInfo | null> {
    try {
      const a = await this.req<Record<string, unknown>>(`/v2/assets/${encodeURIComponent(symbol)}`)
      return {
        symbol: String(a.symbol ?? symbol),
        tradable: a.tradable === true && a.status === 'active',
        fractionable: a.fractionable === true,
        shortable: a.shortable === true,
        exchange: String(a.exchange ?? ''),
      }
    } catch (e) {
      if (e instanceof AlpacaBrokerError && e.status === 404) return null
      throw e
    }
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const rows = await this.req<Record<string, unknown>[]>('/v2/positions')
    return (rows ?? []).map(p => toPosition(p))
  }

  private async getPosition(symbol: string): Promise<BrokerPosition | null> {
    try {
      return toPosition(await this.req<Record<string, unknown>>(`/v2/positions/${encodeURIComponent(symbol)}`))
    } catch (e) {
      if (e instanceof AlpacaBrokerError && e.status === 404) return null   // flat
      throw e
    }
  }

  async submitLimit(req: LimitOrderRequest): Promise<BrokerOrder> {
    return this.submit({
      symbol: req.symbol,
      qty: String(Math.floor(req.qty)),
      side: req.side,
      type: 'limit',
      time_in_force: 'day',           // extended_hours is only valid with DAY
      limit_price: String(roundToTick(req.limitPrice)),
      extended_hours: req.extendedHours,
      client_order_id: req.clientOrderId.slice(0, 128),
    }, req.symbol, req.side, Math.floor(req.qty), req.clientOrderId, roundToTick(req.limitPrice))
  }

  async submitStop(req: StopOrderRequest): Promise<BrokerOrder> {
    return this.submit({
      symbol: req.symbol,
      qty: String(Math.floor(req.qty)),
      side: 'sell',
      type: 'stop',
      time_in_force: 'day',
      stop_price: String(roundToTick(req.stopPrice)),
      client_order_id: req.clientOrderId.slice(0, 128),
    }, req.symbol, 'sell', Math.floor(req.qty), req.clientOrderId, null)
  }

  /** A reject is data, not a crash — return it as a rejected order so the executor can record it on the trade. */
  private async submit(
    body: Record<string, unknown>,
    symbol: string, side: 'buy' | 'sell', qty: number,
    clientOrderId: string, limitPrice: number | null,
  ): Promise<BrokerOrder> {
    try {
      return toOrder(await this.req<RawOrder>('/v2/orders', { method: 'POST', body: JSON.stringify(body) }))
    } catch (e) {
      if (e instanceof AlpacaBrokerError) {
        return {
          id: '', clientOrderId, symbol, side, status: 'rejected',
          qty, filledQty: 0, filledAvgPrice: null, limitPrice,
          submittedAt: Date.now(), rejectReason: e.body.slice(0, 300),
        }
      }
      throw e
    }
  }

  async getOrder(id: string): Promise<BrokerOrder | null> {
    if (!id) return null
    try {
      return toOrder(await this.req<RawOrder>(`/v2/orders/${encodeURIComponent(id)}`))
    } catch (e) {
      if (e instanceof AlpacaBrokerError && e.status === 404) return null
      throw e
    }
  }

  async cancelOrder(id: string): Promise<void> {
    if (!id) return
    try {
      await this.req<null>(`/v2/orders/${encodeURIComponent(id)}`, { method: 'DELETE' })
    } catch (e) {
      // 404 = already gone, 422 = already filled or canceled. Both mean "not resting", which is the goal.
      if (e instanceof AlpacaBrokerError && (e.status === 404 || e.status === 422)) return
      throw e
    }
  }

  async cancelOpenOrders(symbol: string): Promise<number> {
    const rows = await this.req<RawOrder[]>(`/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}`)
    let n = 0
    for (const r of rows ?? []) {
      await this.cancelOrder(r.id)
      n++
    }
    if (n > 0) await this.waitForReleasedShares(symbol)
    return n
  }

  /**
   * Block until canceled orders have actually released their shares.
   *
   * A DELETE only moves an order to `pending_cancel`; Alpaca keeps the shares in
   * `held_for_orders` until it settles, so a replacement sell submitted in that
   * window is rejected for insufficient quantity. Callers cancel precisely
   * because they are about to resubmit, so the wait belongs here rather than at
   * every call site.
   *
   * Bounded and best-effort: on timeout we return and let the submit attempt
   * proceed, because a rejected order is recorded and retried on the next sweep,
   * whereas blocking the loop stalls every other position.
   */
  private async waitForReleasedShares(symbol: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      let position: BrokerPosition | null
      try {
        position = await this.getPosition(symbol)
      } catch {
        return   // can't confirm — don't hold the loop hostage to a flaky read
      }
      if (!position || position.qtyAvailable >= position.qty) return
      if (Date.now() >= deadline) return
      await new Promise(r => setTimeout(r, 150))
    }
  }
}
