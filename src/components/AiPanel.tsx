// components/AiPanel.tsx
'use client'

import { useState } from 'react'

type AiState = {
  loading: boolean
  error: string | null
  answer: string | null
}

export default function AiPanel() {
  const [question, setQuestion] = useState('')
  const [state, setState] = useState<AiState>({
    loading: false,
    error: null,
    answer: null,
  })

  const askAi = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!question.trim()) return

    setState({ loading: true, error: null, answer: null })

    try {
      const res = await fetch('/api/ai-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Request failed')
      }

      setState({
        loading: false,
        error: null,
        answer: data.answer,
      })
    } catch (err: any) {
      console.error(err)
      setState({
        loading: false,
        error: err.message || 'Something went wrong',
        answer: null,
      })
    }
  }

  return (
    <div className="rounded-md border border-slate-800 bg-slate-900/60 p-4 text-sm">
      <h2 className="text-base font-semibold">Ask your SF librarian</h2>
      <p className="mt-1 text-xs text-slate-300">
        Ask for recommendations, signed copies, specific eras, publishers, etc.
      </p>

      <form onSubmit={askAi} className="mt-3 space-y-2">
        <textarea
          value={question}
          onChange={e => setQuestion(e.target.value)}
          rows={4}
          placeholder='e.g. "Show me the best signed Ace Doubles from the 1960s"'
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs focus:outline-none focus:ring focus:ring-sky-500"
        />
        <button
          type="submit"
          disabled={state.loading}
          className="w-full rounded-md bg-sky-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
        >
          {state.loading ? 'Thinking…' : 'Ask AI'}
        </button>
      </form>

      {state.error && (
        <p className="mt-3 text-xs text-red-400">Error: {state.error}</p>
      )}

      {state.answer && (
        <div className="mt-3 rounded border border-slate-800 bg-slate-950 p-3 text-xs leading-relaxed text-slate-200 whitespace-pre-wrap">
          {state.answer}
        </div>
      )}
    </div>
  )
}

