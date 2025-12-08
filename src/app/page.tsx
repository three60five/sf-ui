// app/page.tsx
'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import type { Book } from '@/lib/types'
import AiPanel from '@/components/AiPanel'

export default function HomePage() {
  const [books, setBooks] = useState<Book[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    const fetchBooks = async () => {
      setLoading(true)
      setError(null)

      let query = supabase
        .from('books')
        .select('*')
        .order('sort_title', { ascending: true })
        .limit(200)

      if (search.trim()) {
        query = query.or(
          `title.ilike.%${search}%,author_last_first.ilike.%${search}%`
        )
      }

      const { data, error } = await query

      if (error) {
        console.error(error)
        setError(error.message)
      } else {
        setBooks((data ?? []) as Book[])
      }

      setLoading(false)
    }

    fetchBooks()
  }, [search])

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 md:flex-row">
        {/* Left: library browser */}
        <section className="w-full md:w-2/3">
          <header className="mb-4">
            <h1 className="text-3xl font-semibold tracking-tight">
              Vintage SF Library
            </h1>
            <p className="mt-2 text-sm text-slate-300">
              Browse and query your collection of classic science fiction.
            </p>
          </header>

          <div className="mb-4">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by title or author..."
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm focus:outline-none focus:ring focus:ring-sky-500"
            />
          </div>

          {loading && <p className="text-sm">Loading books…</p>}
          {error && (
            <p className="text-sm text-red-400">Error: {error}</p>
          )}

          <ul className="mt-2 space-y-2 text-sm">
            {books.map(book => (
              <li
                key={book.id}
                className="rounded border border-slate-800 bg-slate-900/60 p-3"
              >
                <div className="flex justify-between gap-2">
                  <div>
                    <div className="font-semibold">{book.title}</div>
                    <div className="text-xs text-slate-300">
                      {book.author_last_first}
                    </div>
                  </div>
                  <div className="text-right text-[11px] text-slate-400">
                    {book.pub_year && <div>{book.pub_year}</div>}
                    {book.publisher && <div>{book.publisher}</div>}
                    {book.signed && <div>Signed</div>}
                  </div>
                </div>
                {book.notes && (
                  <p className="mt-1 line-clamp-2 text-[11px] text-slate-400">
                    {book.notes}
                  </p>
                )}
              </li>
            ))}
            {!loading && !error && books.length === 0 && (
              <p className="mt-4 text-sm text-slate-300">
                No books match your search.
              </p>
            )}
          </ul>
        </section>

        {/* Right: AI panel */}
        <section className="w-full md:w-1/3">
          <AiPanel />
        </section>
      </div>
    </main>
  )
}

