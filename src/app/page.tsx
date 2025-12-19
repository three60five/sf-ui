// app/page.tsx
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import type { Book } from '@/lib/types'

type Suggestion =
  | {
      kind: 'author'
      value: string
      display: string
      alt?: string
      count?: number
    }
  | {
      kind: 'title'
      value: string
      display: string
      meta?: string
      bookId?: number
    }
  | {
      kind: 'series'
      value: string
      display: string
      count?: number
    }
  | {
      kind: 'publisher'
      value: string
      display: string
      count?: number
    }

function swapCommaName(name: string) {
  // "Last, First" -> "First Last" (best effort)
  const parts = name.split(',').map(s => s.trim())
  if (parts.length < 2) return null
  const [last, rest] = parts
  if (!last || !rest) return null
  return `${rest} ${last}`.replace(/\s+/g, ' ').trim()
}

function normalize(s: string) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

function scoreMatch(query: string, candidate: string) {
  const q = normalize(query)
  const c = normalize(candidate)
  if (!q) return 0
  if (c === q) return 100
  if (c.startsWith(q)) return 80
  const wordStart = c.split(/\s+/).some(w => w.startsWith(q))
  if (wordStart) return 65
  if (c.includes(q)) return 45
  return 0
}

function makeIlikePattern(q: string) {
  return `%${q.trim()}%`
}

function dedupeById<T extends { id: number }>(rows: T[]) {
  const map = new Map<number, T>()
  for (const r of rows) map.set(r.id, r)
  return Array.from(map.values())
}

async function fetchUnionByIlike(
  q: string,
  fields: string[],
  select: string,
  limitPerField: number
) {
  const pattern = makeIlikePattern(q)

  const requests = fields.map(field =>
    supabase
      .from('books')
      .select(select)
      .ilike(field, pattern)
      .order('sort_title', { ascending: true })
      .limit(limitPerField)
  )

  const results = await Promise.all(requests)

  const firstErr = results.find(r => r.error)?.error
  if (firstErr) return { data: null as any, error: firstErr }

  const allRows = results.flatMap(r => (r.data ?? []) as any[])
  return { data: dedupeById(allRows), error: null }
}

export default function HomePage() {
  const [books, setBooks] = useState<Book[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const suggestBoxRef = useRef<HTMLDivElement | null>(null)
  const suppressSuggestOpenRef = useRef(false)

  const trimmed = useMemo(() => search.trim(), [search])

  const applySuggestion = (s: Suggestion) => {
    suppressSuggestOpenRef.current = true
    setSearch(s.value)
    setSuggestOpen(false)
    setActiveIndex(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  // Close suggestions on outside click
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (
        !inputRef.current?.contains(t) &&
        !suggestBoxRef.current?.contains(t)
      ) {
        setSuggestOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [])

  // Fetch autocomplete suggestions (no PostgREST .or() parsing)
  useEffect(() => {
    let cancelled = false
    const q = trimmed

    if (suppressSuggestOpenRef.current) {
      // We just applied a suggestion; keep the dropdown closed until user types again.
      setSuggestOpen(false)
      setSuggestLoading(false)
      return
    }

    if (!q) {
      setSuggestions([])
      setSuggestOpen(false)
      setActiveIndex(0)
      return
    }

    const t = window.setTimeout(async () => {
      setSuggestLoading(true)

      const { data, error } = await fetchUnionByIlike(
        q,
        ['title', 'author_last_first', 'series', 'publisher'],
        'id,title,author_last_first,series,pub_year,publisher',
        30
      )

      if (cancelled) return

      if (error) {
        console.error(error)
        setSuggestions([])
        setSuggestLoading(false)
        setSuggestOpen(false)
        return
      }

      const rows = (data ?? []) as Array<{
        id: number
        title: string
        author_last_first: string
        series: string | null
        pub_year: number | null
        publisher: string | null
      }>

      const authorCounts = new Map<string, number>()
      const seriesCounts = new Map<string, number>()
      const publisherCounts = new Map<string, number>()

      for (const r of rows) {
        if (r.author_last_first) {
          authorCounts.set(
            r.author_last_first,
            (authorCounts.get(r.author_last_first) ?? 0) + 1
          )
        }
        if (r.series) {
          seriesCounts.set(r.series, (seriesCounts.get(r.series) ?? 0) + 1)
        }
        if (r.publisher) {
          publisherCounts.set(
            r.publisher,
            (publisherCounts.get(r.publisher) ?? 0) + 1
          )
        }
      }

      const authorSuggestions: Suggestion[] = [...authorCounts.entries()]
        .map(([name, count]) => {
          const alt = swapCommaName(name) ?? undefined
          const bestScore = Math.max(
            scoreMatch(q, name),
            alt ? scoreMatch(q, alt) : 0
          )
          return {
            kind: 'author',
            value: name,
            display: alt && scoreMatch(q, alt) > scoreMatch(q, name) ? alt : name,
            alt,
            count,
            _score: bestScore,
          } as Suggestion & { _score: number }
        })
        .filter((s: any) => s._score > 0)
        .sort(
          (a: any, b: any) =>
            b._score - a._score || (b.count ?? 0) - (a.count ?? 0)
        )
        .slice(0, 6)
        .map((s: any) => {
          const { _score, ...rest } = s
          return rest
        })

      const titleSuggestions: Suggestion[] = rows
        .map(r => {
          const metaParts = [
            r.author_last_first,
            r.pub_year ? String(r.pub_year) : null,
          ].filter(Boolean)
          return {
            kind: 'title',
            value: r.title,
            display: r.title,
            meta: metaParts.join(' • '),
            bookId: r.id,
            _score:
              scoreMatch(q, r.title) * 1.2 + scoreMatch(q, r.author_last_first),
          } as Suggestion & { _score: number }
        })
        .filter((s: any) => s._score > 0)
        .sort((a: any, b: any) => b._score - a._score)
        .slice(0, 8)
        .map((s: any) => {
          const { _score, ...rest } = s
          return rest
        })

      const seriesSuggestions: Suggestion[] = [...seriesCounts.entries()]
        .map(([series, count]) => ({
          kind: 'series',
          value: series,
          display: series,
          count,
          _score: scoreMatch(q, series) + count / 10,
        }))
        .filter((s: any) => s._score > 0)
        .sort((a: any, b: any) => b._score - a._score)
        .slice(0, 4)
        .map((s: any) => {
          const { _score, ...rest } = s
          return rest
        })

      const publisherSuggestions: Suggestion[] = [...publisherCounts.entries()]
        .map(([publisher, count]) => ({
          kind: 'publisher',
          value: publisher,
          display: publisher,
          count,
          _score: scoreMatch(q, publisher) + count / 10,
        }))
        .filter((s: any) => s._score > 0)
        .sort((a: any, b: any) => b._score - a._score)
        .slice(0, 4)
        .map((s: any) => {
          const { _score, ...rest } = s
          return rest
        })

      const next = [
        ...authorSuggestions,
        ...titleSuggestions,
        ...seriesSuggestions,
        ...publisherSuggestions,
      ]

      setSuggestions(next)
      setSuggestLoading(false)
      if (document.activeElement === inputRef.current) {
        setSuggestOpen(true)
      }
      setActiveIndex(0)
    }, 120)

    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [trimmed])

  // Fetch filtered books (mobile-first, full width; no .or())
  useEffect(() => {
    const fetchBooks = async () => {
      setLoading(true)
      setError(null)

      if (!trimmed) {
        const { data, error } = await supabase
          .from('books')
          .select('*')
          .order('sort_title', { ascending: true })
          .limit(600)

        if (error) {
          console.error(error)
          setError(error.message)
        } else {
          setBooks((data ?? []) as Book[])
        }

        setLoading(false)
        return
      }

      const { data, error } = await fetchUnionByIlike(
        trimmed,
        ['title', 'author_last_first', 'series', 'publisher', 'notes'],
        '*',
        250
      )

      if (error) {
        console.error(error)
        setError(error.message)
      } else {
        const sorted = ((data ?? []) as Book[])
          .slice()
          .sort((a, b) =>
            ((a as any).sort_title ?? a.title).localeCompare(
              ((b as any).sort_title ?? b.title) as string
            )
          )
        setBooks(sorted.slice(0, 600))
      }

      setLoading(false)
    }

    fetchBooks()
  }, [trimmed])

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="w-full px-3 py-4 sm:px-6 sm:py-6">
        {/* Left: library browser */}
        <section className="w-full">
          <header className="mb-4">
            <h1 className="text-3xl font-semibold tracking-tight">
              Vintage SF Library
            </h1>
            <p className="mt-2 text-sm text-slate-300">
              Browse and query your collection of classic science fiction.
            </p>
          </header>

          <div className="mb-4 relative">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={e => {
                suppressSuggestOpenRef.current = false
                setSearch(e.target.value)
              }}
              onFocus={() => {
                if (suggestions.length > 0) setSuggestOpen(true)
              }}
              onKeyDown={e => {
                if (
                  !suggestOpen &&
                  (e.key === 'ArrowDown' || e.key === 'ArrowUp')
                ) {
                  if (suggestions.length > 0) setSuggestOpen(true)
                  return
                }

                if (!suggestOpen) return

                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setActiveIndex(i => Math.min(i + 1, suggestions.length - 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setActiveIndex(i => Math.max(i - 1, 0))
                } else if (e.key === 'Enter') {
                  const s = suggestions[activeIndex]
                  if (s) {
                    e.preventDefault()
                    applySuggestion(s)
                  }
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setSuggestOpen(false)
                }
              }}
              placeholder="Search: title, author, series, publisher…"
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm focus:outline-none focus:ring focus:ring-sky-500"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />

            {suggestOpen && trimmed && (
              <div
                ref={suggestBoxRef}
                className="absolute z-20 mt-2 w-full overflow-hidden rounded-md border border-slate-800 bg-slate-950 shadow-xl"
                role="listbox"
              >
                <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2 text-[11px] text-slate-400">
                  <span>Suggestions</span>
                  <span className="flex items-center gap-3">
                    {suggestLoading && <span>Searching…</span>}
                    <span>↑↓</span>
                    <span>Enter</span>
                    <span>Esc</span>
                  </span>
                </div>

                {suggestions.length === 0 && !suggestLoading ? (
                  <div className="px-3 py-3 text-xs text-slate-400">
                    No suggestions.
                  </div>
                ) : (
                  <ul className="max-h-80 overflow-auto py-1 text-sm">
                    {(() => {
                      let lastKind: Suggestion['kind'] | null = null
                      return suggestions.map((s, idx) => {
                        const showHeader = s.kind !== lastKind
                        lastKind = s.kind

                        const headerLabel =
                          s.kind === 'author'
                            ? 'Authors'
                            : s.kind === 'title'
                              ? 'Titles'
                              : s.kind === 'series'
                                ? 'Series'
                                : 'Publishers'

                        return (
                          <li key={`${s.kind}-${s.value}-${idx}`}>
                            {showHeader && (
                              <div className="px-3 pb-1 pt-2 text-[11px] font-semibold tracking-wide text-slate-400">
                                {headerLabel}
                              </div>
                            )}
                            <button
                              type="button"
                              role="option"
                              aria-selected={idx === activeIndex}
                              className={
                                'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-900/60 ' +
                                (idx === activeIndex ? 'bg-slate-900/60' : '')
                              }
                              onMouseEnter={() => setActiveIndex(idx)}
                              onMouseDown={e => {
                                e.preventDefault()
                              }}
                              onClick={() => applySuggestion(s)}
                            >
                              <div className="min-w-0">
                                <div className="truncate font-medium text-slate-100">
                                  {s.display}
                                </div>
                                {s.kind === 'author' &&
                                  s.alt &&
                                  s.alt !== s.display && (
                                    <div className="truncate text-[11px] text-slate-400">
                                      aka {s.alt}
                                    </div>
                                  )}
                                {s.kind === 'title' && s.meta && (
                                  <div className="truncate text-[11px] text-slate-400">
                                    {s.meta}
                                  </div>
                                )}
                              </div>

                              <div className="shrink-0 text-[11px] text-slate-400">
                                {'count' in s && s.count ? `${s.count}` : ''}
                              </div>
                            </button>
                          </li>
                        )
                      })
                    })()}
                  </ul>
                )}
              </div>
            )}
          </div>

          {loading && <p className="text-sm">Loading books…</p>}
          {error && <p className="text-sm text-red-400">Error: {error}</p>}

          <ul className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2 xl:grid-cols-3">
            {books.map(book => (
              <li
                key={book.id}
                className="rounded border border-slate-800 bg-slate-900/60 p-3 hover:border-slate-700"
              >
                <div className="flex justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{book.title}</div>
                    <div className="truncate text-xs text-slate-300">
                      {book.author_last_first}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-[11px] text-slate-400">
                    {book.pub_year && <div>{book.pub_year}</div>}
                    {book.publisher && <div>{book.publisher}</div>}
                    {book.signed && <div>Signed</div>}
                  </div>
                </div>
                {book.notes && (
                  <p className="mt-1 line-clamp-3 text-[11px] text-slate-400">
                    {book.notes}
                  </p>
                )}
              </li>
            ))}

            {!loading && !error && books.length === 0 && (
              <li className="col-span-full">
                <p className="mt-4 text-sm text-slate-300">
                  No books match your search.
                </p>
              </li>
            )}
          </ul>
        </section>

      </div>
    </main>
  )
}
