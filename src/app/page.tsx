// app/page.tsx
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase, supabaseEnvReady } from '@/lib/supabaseClient'
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

function getAuthorDisplayName(author: NonNullable<Book['book_contributors']>[0]['authors']) {
  return author?.display_name ?? author?.sort_name ?? null
}

function getBookAuthors(book: Book) {
  const contributors = book.book_contributors ?? []
  return contributors
    .filter(c => c.role === 'author')
    .slice()
    .sort(
      (a, b) => (a.credit_order ?? Number.MAX_SAFE_INTEGER) - (b.credit_order ?? Number.MAX_SAFE_INTEGER)
    )
    .map(c => getAuthorDisplayName(c.authors))
    .filter((name): name is string => !!name)
}

function getBookPublisher(book: Book) {
  return book.publishers?.name ?? null
}

const bookSelect =
  'id,title,sort_title,pub_year,series,work_type,tier,signed,notes,created_at,' +
  'publishers(name),book_contributors(role,credit_order,authors(display_name,sort_name))'

async function fetchBooksByIlikeFields(
  q: string,
  fields: string[],
  limitPerField: number
) {
  const client = supabase
  if (!client) {
    return { data: null as any, error: new Error('Missing Supabase env vars') }
  }
  const pattern = makeIlikePattern(q)

  const requests = fields.map(field =>
    client
      .from('books')
      .select(bookSelect)
      .ilike(field, pattern)
      .order('sort_title', { ascending: true })
      .limit(limitPerField)
  )

  const results = await Promise.all(requests)
  const firstErr = results.find(r => r.error)?.error
  if (firstErr) return { data: null as any, error: firstErr }

  const allRows = results.flatMap(
    r => ((r.data ?? []) as unknown) as Book[]
  )
  return { data: dedupeById(allRows), error: null }
}

async function fetchBooksByAuthor(q: string, limitPerField: number) {
  const client = supabase
  if (!client) {
    return { data: null as any, error: new Error('Missing Supabase env vars') }
  }
  const pattern = makeIlikePattern(q)
  const requests = [
    client
      .from('book_contributors')
      .select('book_id,authors!inner(display_name,sort_name)')
      .eq('role', 'author')
      .ilike('authors.display_name', pattern)
      .limit(limitPerField),
    client
      .from('book_contributors')
      .select('book_id,authors!inner(display_name,sort_name)')
      .eq('role', 'author')
      .ilike('authors.sort_name', pattern)
      .limit(limitPerField),
  ]

  const results = await Promise.all(requests)
  const firstErr = results.find(r => r.error)?.error
  if (firstErr) return { data: null as any, error: firstErr }

  const ids = Array.from(
    new Set(
      results.flatMap(r => (r.data ?? []) as Array<{ book_id: number }>).map(r => r.book_id)
    )
  )

  if (ids.length === 0) return { data: [] as Book[], error: null }

  const { data, error } = await client
    .from('books')
    .select(bookSelect)
    .in('id', ids)
    .order('sort_title', { ascending: true })

  return { data: ((data ?? []) as unknown) as Book[], error }
}

async function fetchBooksByPublisher(q: string, limitPerField: number) {
  const client = supabase
  if (!client) {
    return { data: null as any, error: new Error('Missing Supabase env vars') }
  }
  const pattern = makeIlikePattern(q)
  const { data: publishers, error } = await client
    .from('publishers')
    .select('id,name')
    .ilike('name', pattern)
    .limit(limitPerField)

  if (error) return { data: null as any, error }

  const publisherIds = (publishers ?? []).map(p => p.id)
  if (publisherIds.length === 0) return { data: [] as Book[], error: null }

  const { data, error: booksError } = await client
    .from('books')
    .select(bookSelect)
    .in('publisher_id', publisherIds)
    .order('sort_title', { ascending: true })

  return { data: ((data ?? []) as unknown) as Book[], error: booksError }
}

async function fetchBooksForSearch(
  q: string,
  fields: string[],
  limitPerField: number
) {
  const [bookFieldResult, authorResult, publisherResult] = await Promise.all([
    fetchBooksByIlikeFields(q, fields, limitPerField),
    fetchBooksByAuthor(q, limitPerField),
    fetchBooksByPublisher(q, limitPerField),
  ])

  const firstErr = bookFieldResult.error || authorResult.error || publisherResult.error
  if (firstErr) return { data: null as any, error: firstErr }

  const combined = dedupeById([
    ...(bookFieldResult.data ?? []),
    ...(authorResult.data ?? []),
    ...(publisherResult.data ?? []),
  ])

  return { data: combined, error: null }
}

export default function HomePage() {
  const [books, setBooks] = useState<Book[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [groupMode, setGroupMode] = useState<'author' | 'publisher'>('author')
  const [recentSearches, setRecentSearches] = useState<string[]>([])
  const [randomPicks, setRandomPicks] = useState<Book[]>([])

  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const suggestBoxRef = useRef<HTMLDivElement | null>(null)
  const suppressSuggestOpenRef = useRef(false)

  const trimmed = useMemo(() => search.trim(), [search])
  const recentStorageKey = 'sf-ui-recent-searches'

  const shuffleSample = (rows: Book[], count: number) => {
    const copy = rows.slice()
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
    }
    return copy.slice(0, count)
  }

  const applySuggestion = (s: Suggestion) => {
    suppressSuggestOpenRef.current = true
    setSearch(s.value)
    setSuggestOpen(false)
    setActiveIndex(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const applyQuickSearch = (value: string) => {
    suppressSuggestOpenRef.current = true
    setSearch(value)
    setSuggestOpen(false)
    setActiveIndex(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const storeRecentSearch = (value: string) => {
    const cleaned = value.trim()
    if (!cleaned) return
    setRecentSearches(prev => {
      const next = [cleaned, ...prev.filter(item => item !== cleaned)].slice(
        0,
        6
      )
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(recentStorageKey, JSON.stringify(next))
      }
      return next
    })
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

  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = window.localStorage.getItem(recentStorageKey)
    if (!stored) return
    try {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed)) {
        setRecentSearches(parsed.filter((item): item is string => !!item))
      }
    } catch {
      setRecentSearches([])
    }
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

      const { data, error } = await fetchBooksForSearch(
        q,
        ['title', 'series'],
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

      const rows = (data ?? []) as Book[]

      const authorCounts = new Map<string, number>()
      const authorAlt = new Map<string, string | undefined>()
      const seriesCounts = new Map<string, number>()
      const publisherCounts = new Map<string, number>()

      for (const r of rows) {
        const authors = getBookAuthors(r)
        for (const name of authors) {
          authorCounts.set(name, (authorCounts.get(name) ?? 0) + 1)
        }

        for (const contributor of r.book_contributors ?? []) {
          if (contributor.role !== 'author') continue
          const display = getAuthorDisplayName(contributor.authors)
          const sort = contributor.authors?.sort_name ?? null
          if (display && sort && display !== sort && !authorAlt.has(display)) {
            authorAlt.set(display, sort)
          }
        }

        if (r.series) {
          seriesCounts.set(r.series, (seriesCounts.get(r.series) ?? 0) + 1)
        }

        const publisherName = getBookPublisher(r)
        if (publisherName) {
          publisherCounts.set(
            publisherName,
            (publisherCounts.get(publisherName) ?? 0) + 1
          )
        }
      }

      const authorSuggestions: Suggestion[] = [...authorCounts.entries()]
        .map(([name, count]) => {
          const alt = authorAlt.get(name)
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
          const authors = getBookAuthors(r)
          const metaParts = [
            authors.length > 0 ? authors.join(', ') : null,
            r.pub_year ? String(r.pub_year) : null,
          ].filter(Boolean)
          return {
            kind: 'title',
            value: r.title,
            display: r.title,
            meta: metaParts.join(' • '),
            bookId: r.id,
            _score:
              scoreMatch(q, r.title) * 1.2 +
              (authors[0] ? scoreMatch(q, authors[0]) : 0),
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

      const client = supabase
      if (!supabaseEnvReady || !client) {
        setError('Missing Supabase env vars')
        setLoading(false)
        return
      }

      if (!trimmed) {
        const { data, error } = await client
          .from('books')
          .select(bookSelect)
          .order('sort_title', { ascending: true })
          .limit(600)

        if (error) {
          console.error(error)
          setError(error.message)
        } else {
          const nextBooks = ((data ?? []) as unknown) as Book[]
          setBooks(nextBooks)
          setRandomPicks(shuffleSample(nextBooks, 12))
        }

        setLoading(false)
        return
      }

      const { data, error } = await fetchBooksForSearch(
        trimmed,
        ['title', 'series', 'notes'],
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

  useEffect(() => {
    if (!trimmed) return
    const t = window.setTimeout(() => {
      storeRecentSearch(trimmed)
    }, 700)
    return () => window.clearTimeout(t)
  }, [trimmed])

  useEffect(() => {
    if (!trimmed && books.length > 0 && randomPicks.length === 0) {
      setRandomPicks(shuffleSample(books, 12))
    }
  }, [books, randomPicks.length, trimmed])

  const groupStats = useMemo(() => {
    const author = new Map<string, number>()
    const publisher = new Map<string, number>()

    for (const book of books) {
      const authors = getBookAuthors(book)
      for (const name of authors) {
        author.set(name, (author.get(name) ?? 0) + 1)
      }

      const publisherName = getBookPublisher(book)
      if (publisherName) {
        publisher.set(
          publisherName,
          (publisher.get(publisherName) ?? 0) + 1
        )
      }
    }

    const toSorted = (map: Map<string, number>) =>
      [...map.entries()]
        .filter(([name]) => name.trim().length > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

    return {
      author: toSorted(author),
      publisher: toSorted(publisher),
    }
  }, [books])

  const groupEntries = groupStats[groupMode].slice(0, 12)

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

          {!trimmed ? (
            <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
              <div className="space-y-6">
                <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                        Explore by
                      </h2>
                      <p className="mt-1 text-xs text-slate-400">
                        Jump into the collection through key creators and
                        imprints.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      {[
                        { id: 'author', label: 'Authors' },
                        { id: 'publisher', label: 'Publishers' },
                      ].map(option => (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() =>
                            setGroupMode(
                              option.id as 'author' | 'publisher'
                            )
                          }
                          className={
                            'rounded-full border px-3 py-1 transition ' +
                            (groupMode === option.id
                              ? 'border-sky-400 bg-sky-500/20 text-sky-100'
                              : 'border-slate-700 text-slate-300 hover:border-slate-500')
                          }
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {groupEntries.length === 0 ? (
                    <p className="mt-4 text-xs text-slate-400">
                      Nothing to group yet. Try another filter or refresh the
                      library.
                    </p>
                  ) : (
                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                      {groupEntries.map(([label, count]) => (
                        <button
                          key={label}
                          type="button"
                          onClick={() => applyQuickSearch(label)}
                          className="flex items-center justify-between rounded border border-slate-800 bg-slate-950/60 px-3 py-2 text-left text-sm hover:border-slate-600"
                        >
                          <span className="truncate font-medium">{label}</span>
                          <span className="ml-2 shrink-0 text-xs text-slate-400">
                            {count} titles
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                        Recent searches
                      </h2>
                      <p className="mt-1 text-xs text-slate-400">
                        Pick up where you left off.
                      </p>
                    </div>
                  </div>
                  {recentSearches.length === 0 ? (
                    <p className="mt-3 text-xs text-slate-400">
                      No recent searches yet. Start typing to build your
                      history.
                    </p>
                  ) : (
                    <div className="mt-3 flex flex-wrap gap-2 text-xs">
                      {recentSearches.map(item => (
                        <button
                          key={item}
                          type="button"
                          onClick={() => applyQuickSearch(item)}
                          className="rounded-full border border-slate-700 px-3 py-1 text-slate-200 hover:border-slate-500"
                        >
                          {item}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                      Random picks
                    </h2>
                    <p className="mt-1 text-xs text-slate-400">
                      A rotating slice of your shelves.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setRandomPicks(shuffleSample(books, randomPicks.length || 12))
                    }
                    disabled={loading || books.length === 0}
                    className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Shuffle
                  </button>
                </div>

                {randomPicks.length === 0 ? (
                  <p className="mt-4 text-xs text-slate-400">
                    Loading a random stack…
                  </p>
                ) : (
                  <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
                    {randomPicks.map(book => (
                      <li
                        key={book.id}
                        className="rounded border border-slate-800 bg-slate-950/60 p-3 hover:border-slate-700"
                      >
                        {(() => {
                          const authorNames = getBookAuthors(book)
                          const publisherName = getBookPublisher(book)
                          return (
                            <div className="flex justify-between gap-2">
                              <div className="min-w-0">
                                <div className="truncate font-semibold">
                                  {book.title}
                                </div>
                                {authorNames.length > 0 && (
                                  <div className="truncate text-xs text-slate-300">
                                    {authorNames.join(', ')}
                                  </div>
                                )}
                              </div>
                              <div className="shrink-0 text-right text-[11px] text-slate-400">
                                {book.pub_year && <div>{book.pub_year}</div>}
                                {publisherName && <div>{publisherName}</div>}
                              </div>
                            </div>
                          )
                        })()}
                        {book.notes && (
                          <p className="mt-1 line-clamp-2 text-[11px] text-slate-400">
                            {book.notes}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : books.length === 0 ? (
            !loading &&
            !error && (
              <p className="mt-4 text-sm text-slate-300">
                No books match your search.
              </p>
            )
          ) : (
            <div className="mt-3 overflow-hidden rounded border border-slate-800">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-900/70 text-[11px] uppercase tracking-wide text-slate-400">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      Title &amp; Author
                    </th>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      Publisher
                    </th>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      Year
                    </th>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      Signed
                    </th>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      Notes
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {books.map(book => {
                    const authorNames = getBookAuthors(book)
                    const publisherName = getBookPublisher(book)
                    return (
                      <tr key={book.id} className="hover:bg-slate-900/40">
                        <td className="px-3 py-3 align-top">
                          <div className="font-semibold text-slate-100">
                            {book.title}
                          </div>
                          {authorNames.length > 0 && (
                            <div className="text-xs text-slate-300">
                              {authorNames.join(', ')}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3 align-top text-xs text-slate-300">
                          {publisherName ?? '—'}
                        </td>
                        <td className="px-3 py-3 align-top text-xs text-slate-300">
                          {book.pub_year ?? '—'}
                        </td>
                        <td className="px-3 py-3 align-top text-xs text-slate-300">
                          {book.signed ? 'Signed' : '—'}
                        </td>
                        <td className="px-3 py-3 align-top text-xs text-slate-300">
                          {book.notes ? (
                            <p className="line-clamp-2">{book.notes}</p>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

      </div>
    </main>
  )
}
