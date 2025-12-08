// app/api/ai-query/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabaseClient'
import OpenAI from 'openai'
import type { Book } from '@/lib/types'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

export async function POST(req: NextRequest) {
  try {
    const { question } = await req.json()

    if (!question || typeof question !== 'string') {
      return NextResponse.json(
        { error: 'Missing question' },
        { status: 400 }
      )
    }

    // 1) Get candidate books from Supabase (simple text search for now)
    const { data, error } = await supabase
      .from('books')
      .select('*')
      .or(
        `title.ilike.%${question}%,author_last_first.ilike.%${question}%,notes.ilike.%${question}%`
      )
      .limit(30)

    if (error) {
      console.error('Supabase error:', error)
      return NextResponse.json(
        { error: 'Database error' },
        { status: 500 }
      )
    }

    const books = (data ?? []) as Book[]

    // 2) Build a compact text context for the model
    const context = books
      .map(
        b =>
          `- "${b.title}" by ${b.author_last_first}` +
          (b.pub_year ? ` (${b.pub_year})` : '') +
          (b.publisher ? `, ${b.publisher}` : '') +
          (b.notes ? ` — Notes: ${b.notes}` : '')
      )
      .join('\n')

    const systemPrompt = `
You are a helpful sci-fi librarian specializing in vintage science fiction.
You are answering questions about a specific private collection of books.
You receive a question and a list of books from that collection.

Use ONLY the provided books as your source of truth.
Recommend specific titles where possible and explain briefly why.
If the answer isn't clear from the data, say so and suggest the closest matches.
`

    const userPrompt = `
Question: ${question}

Books in the collection:
${context || '(no matching books were found for this query)'}
`

    // 3) Call the model
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // or another chat model you prefer
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.4,
      max_tokens: 500,
    })

    const answer =
      completion.choices[0]?.message?.content ??
      'I could not generate an answer.'

    return NextResponse.json({
      answer,
      books,
    })
  } catch (err) {
    console.error(err)
    return NextResponse.json(
      { error: 'Unexpected error' },
      { status: 500 }
    )
  }
}

