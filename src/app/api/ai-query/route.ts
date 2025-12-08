// app/api/ai-query/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabaseClient'
import OpenAI from 'openai'
import type { Book } from '@/lib/types'

// Force Node runtime (safer with OpenAI SDK)
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const openaiApiKey = process.env.OPENAI_API_KEY

const openai = openaiApiKey
  ? new OpenAI({ apiKey: openaiApiKey })
  : null

export async function POST(req: NextRequest) {
  try {
    // 1) Basic input validation
    let body: any
    try {
      body = await req.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 }
      )
    }

    const question = body?.question
    if (!question || typeof question !== 'string') {
      return NextResponse.json(
        { error: 'Missing "question" field in request body' },
        { status: 400 }
      )
    }

    // 2) Check OpenAI configuration
    if (!openai) {
      return NextResponse.json(
        {
          error:
            'OPENAI_API_KEY is not set on the server. Add it to your environment variables and redeploy.',
        },
        { status: 500 }
      )
    }

    // 3) Supabase query for relevant books
    const { data, error: dbError } = await supabase
      .from('books')
      .select('*')
      .or(
        `title.ilike.%${question}%,author_last_first.ilike.%${question}%,notes.ilike.%${question}%`
      )
      .limit(30)

    if (dbError) {
      console.error('Supabase error in /api/ai-query:', dbError)
      return NextResponse.json(
        { error: `Supabase error: ${dbError.message}` },
        { status: 500 }
      )
    }

    const books = (data ?? []) as Book[]

    const context =
      books.length === 0
        ? '(No matching books were found for this query in the collection.)'
        : books
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
${context}
`

    // 4) Call OpenAI
    let answer = ''

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini', // or another chat-capable model you have access to
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.4,
        max_tokens: 500,
      })

      answer =
        completion.choices[0]?.message?.content ??
        'I could not generate an answer.'
    } catch (openAiError: any) {
      console.error('OpenAI error in /api/ai-query:', openAiError)
      return NextResponse.json(
        {
          error:
            'OpenAI request failed. Check that your OPENAI_API_KEY is valid and that the model name is correct.',
          details: openAiError?.message || String(openAiError),
        },
        { status: 500 }
      )
    }

    return NextResponse.json({ answer, books })
  } catch (err: any) {
    console.error('Unexpected error in /api/ai-query:', err)
    return NextResponse.json(
      {
        error: 'Unexpected server error in /api/ai-query.',
        details: err?.message || String(err),
      },
      { status: 500 }
    )
  }
}

