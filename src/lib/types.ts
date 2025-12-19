// lib/types.ts
export type Book = {
  id: number
  author_last_first: string
  title: string
  sort_title: string | null
  pub_year: number | null
  publisher: string | null
  series: string | null
  work_type: string | null
  tier: string | null
  cover_artist?: string | null
  signed: boolean
  notes: string | null
  created_at: string
}
