# Intraday Trading Companion

A professional local trading dashboard and MCP server for intraday analysis during the US trading session.

## Quick start

### 1. Add your FMP API key

```bash
cp .env.local.example .env.local
# Open .env.local and set FMP_API_KEY=your_actual_key
```

FMP Premium subscription is required for intraday candles and real-time quotes.

### 2. Install dependencies

```bash
npm install
```

### 3. Start the dashboard

```bash
npm run dev
```

Open **http://localhost:3000**

### 4. Start the MCP server (second terminal)

```bash
npm run mcp
```

---

## Connecting to Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "trading-companion": {
      "command": "npx",
      "args": ["tsx", "/Users/elonmusk/Companion/mcp-server/server.ts"],
      "env": {
        "NEXT_PUBLIC_APP_URL": "http://localhost:3000"
      }
    }
  }
}
```

Restart Claude Code. The Next.js dashboard must be running on port 3000.

## Connecting to Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "trading-companion": {
      "command": "npx",
      "args": ["tsx", "/Users/elonmusk/Companion/mcp-server/server.ts"],
      "env": {
        "NEXT_PUBLIC_APP_URL": "http://localhost:3000"
      }
    }
  }
}
```

---

## First ticker test

1. Open http://localhost:3000 — scanner populates in seconds
2. Click any ticker to load chart and analysis
3. In Claude: ask `get_top_gainers` then `get_setup_report` for your chosen symbol

---

## Folder structure

```
src/
  app/api/          # Server-side API routes (gainers, snapshot, candles, news)
  lib/              # fmp-client, technical, setup-engine, news-engine, cache
  components/       # scanner, chart, companion panels
  hooks/            # useScanner (3-min poll), useSnapshot (20-sec poll)
  store/            # Zustand state
  types/            # Shared TypeScript types
mcp-server/         # MCP server (npx tsx mcp-server/server.ts)
tests/              # 28 vitest unit tests
```

## FMP endpoints

| Endpoint | Purpose |
|---|---|
| /stable/gainers | Top gainers scan |
| /stable/quote/{symbol} | Real-time quote |
| /stable/historical-chart/{interval}/{symbol} | Intraday candles |
| /stable/historical-price-eod/full/{symbol} | Daily candles |
| /stable/profile/{symbol} | Float, market cap, exchange |
| /stable/stock-news | News articles |
| /stable/press-releases/{symbol} | Press releases |

## MCP tools

get_top_gainers · get_scanner_results · get_ticker_snapshot · get_intraday_candles
get_technical_levels · get_support_resistance · get_pullback_scenarios
get_recent_news · get_catalyst_analysis · get_setup_report · compare_tickers · get_daily_context

## Troubleshooting

**No gainers** — Check FMP_API_KEY and Premium subscription. Gainers list is empty outside US market hours.

**Blank chart** — Intraday candles need FMP Premium. Verify the endpoint is on your plan.

**MCP error** — The Next.js server must be running on port 3000 before starting the MCP server.

**tsc path error on Node 24** — Use `node node_modules/typescript/bin/tsc --noEmit` directly.

---

This tool provides information and scenario analysis only. It does not place trades or constitute financial advice.
