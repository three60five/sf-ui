// lib/types.ts
export type Author = {
  display_name: string | null
  sort_name: string | null
}

export type BookContributor = {
  role: 'author' | 'editor'
  credit_order: number | null
  authors: Author | null
}

export type Publisher = {
  name: string
}

export type Book = {
  id: number
  title: string
  sort_title: string | null
  pub_year: number | null
  series: string | null
  work_type: string | null
  tier: string | null
  signed: boolean
  notes: string | null
  created_at: string
  publishers: Publisher | null
  book_contributors: BookContributor[] | null
}
