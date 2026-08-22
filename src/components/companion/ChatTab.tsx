'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import type { TickerSnapshot } from '@/types'

interface Message {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
}

const SUGGESTED_PROMPTS = [
  'Walk me through this setup — is it worth the risk?',
  'What are the main reasons NOT to take this trade?',
  'Where would you size in and what would your stop be?',
  'Is the catalyst strong enough to justify chasing?',
  'How extended is this from a safe entry point?',
  'Compare the breakout vs pullback entry here',
]

interface Props {
  snapshot: TickerSnapshot | null
  symbol: string | null
}

export function ChatTab({ snapshot, symbol }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Auto-scroll to bottom when messages update
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Reset conversation when ticker changes — intentional state sync on prop change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMessages([])
    setError(null)
  }, [symbol])

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || streaming) return

    setError(null)
    const userMsg: Message = { role: 'user', content: trimmed }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setStreaming(true)

    // Add empty assistant message that we'll stream into
    setMessages(prev => [...prev, { role: 'assistant', content: '', streaming: true }])

    abortRef.current = new AbortController()

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          snapshot,
        }),
        signal: abortRef.current.signal,
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }

      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      if (!reader) throw new Error('No response stream')

      let accumulated = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        accumulated += decoder.decode(value, { stream: true })
        setMessages(prev => {
          const updated = [...prev]
          updated[updated.length - 1] = { role: 'assistant', content: accumulated, streaming: true }
          return updated
        })
      }

      // Finalise — remove streaming flag
      setMessages(prev => {
        const updated = [...prev]
        updated[updated.length - 1] = { role: 'assistant', content: accumulated }
        return updated
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // User cancelled — finalise whatever was streamed
        setMessages(prev => {
          const updated = [...prev]
          const last = updated[updated.length - 1]
          if (last?.streaming) {
            updated[updated.length - 1] = { role: 'assistant', content: last.content + ' _(stopped)_' }
          }
          return updated
        })
      } else {
        setError((err as Error).message)
        setMessages(prev => prev.filter(m => !m.streaming))
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [messages, snapshot, streaming])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send(input)
    }
  }

  const stop = () => {
    abortRef.current?.abort()
  }

  const clear = () => {
    setMessages([])
    setError(null)
  }

  return (
    <div className="flex flex-col h-full">

      {/* Context banner */}
      {symbol && snapshot ? (
        <div className="px-3 py-1.5 bg-blue-950/30 border-b border-blue-900/30 flex-shrink-0">
          <span className="text-xs text-blue-400">
            Context: <span className="font-semibold">{symbol}</span> ${snapshot.quote.price.toFixed(2)} · {snapshot.setupScore.total}/100 · {snapshot.sessionType}
          </span>
          {messages.length > 0 && (
            <button onClick={clear} className="ml-3 text-xs text-gray-600 hover:text-gray-400 float-right">
              Clear chat
            </button>
          )}
        </div>
      ) : (
        <div className="px-3 py-1.5 bg-gray-900/40 border-b border-gray-800 flex-shrink-0">
          <span className="text-xs text-gray-600">No ticker selected — chat about general concepts or select a ticker first</span>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0">

        {/* Greeting / suggestions */}
        {messages.length === 0 && (
          <div className="space-y-3">
            <div className="text-xs text-gray-500 leading-relaxed">
              {symbol
                ? `Ask me anything about ${symbol} — the setup, entry timing, risk, position sizing, or just walk me through your thinking.`
                : `Select a ticker from the scanner, then ask me about the setup, risks, or trade plan.`}
            </div>
            {symbol && (
              <div className="space-y-1">
                <div className="text-xs text-gray-700 mb-1.5">Suggested questions:</div>
                {SUGGESTED_PROMPTS.map((p, i) => (
                  <button
                    key={i}
                    onClick={() => send(p)}
                    disabled={streaming}
                    className="w-full text-left text-xs px-2.5 py-1.5 rounded bg-gray-900 border border-gray-800 text-gray-400 hover:border-gray-600 hover:text-gray-200 transition-colors disabled:opacity-40"
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Message history */}
        {messages.map((m, i) => (
          <MessageBubble key={i} message={m} />
        ))}

        {/* Error */}
        {error && (
          <div className="text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded px-3 py-2">
            {error.includes('ANTHROPIC_API_KEY')
              ? 'Chat is not configured. Add ANTHROPIC_API_KEY to your .env.local file and restart the server.'
              : error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="flex-shrink-0 border-t border-gray-800 p-3">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={streaming}
            placeholder={streaming ? 'Responding...' : 'Ask about this setup... (Enter to send)'}
            rows={2}
            className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-200 placeholder-gray-600 resize-none focus:outline-none focus:border-blue-600 disabled:opacity-50"
          />
          {streaming ? (
            <button
              onClick={stop}
              className="px-3 py-2 rounded-lg bg-red-900/40 border border-red-700 text-red-400 text-xs hover:bg-red-900/60 transition-colors flex-shrink-0"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={() => send(input)}
              disabled={!input.trim()}
              className="px-3 py-2 rounded-lg bg-blue-700 text-white text-xs hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
            >
              Send
            </button>
          )}
        </div>
        <div className="text-[10px] text-gray-700 mt-1">Shift+Enter for new line · Enter to send</div>
      </div>
    </div>
  )
}

function MessageBubble({ message: m }: { message: Message }) {
  const isUser = m.role === 'user'

  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* Avatar */}
      <div className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${
        isUser ? 'bg-blue-700 text-white' : 'bg-gray-700 text-gray-300'
      }`}>
        {isUser ? 'Y' : 'AI'}
      </div>

      {/* Bubble */}
      <div className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
        isUser
          ? 'bg-blue-900/40 border border-blue-800/40 text-gray-200'
          : 'bg-gray-900 border border-gray-800 text-gray-300'
      }`}>
        <MarkdownText text={m.content} />
        {m.streaming && m.content && (
          <span className="inline-block w-1.5 h-3.5 bg-gray-400 ml-0.5 animate-pulse align-middle" />
        )}
      </div>
    </div>
  )
}

// Minimal markdown renderer — bold, bullet lists, inline code
function MarkdownText({ text }: { text: string }) {
  if (!text) return null

  // Split into lines and render
  const lines = text.split('\n')
  const elements: React.ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Key each block by the line index where it STARTS — the inner loops below
    // advance `i` past the block, so keying on `i` after them collides with the
    // next element (two children with the same key).
    const start = i

    if (line.startsWith('- ') || line.startsWith('• ')) {
      // Bullet list — collect consecutive bullets
      const items: string[] = []
      while (i < lines.length && (lines[i].startsWith('- ') || lines[i].startsWith('• '))) {
        items.push(lines[i].replace(/^[-•] /, ''))
        i++
      }
      elements.push(
        <ul key={start} className="list-disc list-inside space-y-0.5 my-1">
          {items.map((it, j) => (
            <li key={j}><InlineText text={it} /></li>
          ))}
        </ul>
      )
    } else if (/^\d+\. /.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\. /, ''))
        i++
      }
      elements.push(
        <ol key={start} className="list-decimal list-inside space-y-0.5 my-1">
          {items.map((it, j) => (
            <li key={j}><InlineText text={it} /></li>
          ))}
        </ol>
      )
    } else if (line === '') {
      elements.push(<div key={start} className="h-1" />)
      i++
    } else {
      elements.push(<p key={start} className="leading-relaxed"><InlineText text={line} /></p>)
      i++
    }
  }

  return <>{elements}</>
}

function InlineText({ text }: { text: string }) {
  // Replace **bold**, *italic*, `code`
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g)
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i} className="text-white font-semibold">{part.slice(2, -2)}</strong>
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return <code key={i} className="bg-gray-800 text-green-400 px-1 rounded text-[10px] font-mono">{part.slice(1, -1)}</code>
        }
        if (part.startsWith('*') && part.endsWith('*')) {
          return <em key={i} className="text-gray-300 italic">{part.slice(1, -1)}</em>
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}
