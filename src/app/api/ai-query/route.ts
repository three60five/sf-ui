// src/app/api/ai-query/route.ts
import { NextResponse } from "next/server"
import OpenAI from "openai"

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

export async function POST(req: Request) {
  try {
    // Guard: key must exist on the server
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "Server misconfigured: OPENAI_API_KEY is missing." },
        { status: 500 }
      )
    }

    const body = await req.json().catch(() => ({} as any))
    const question = typeof body?.question === "string" ? body.question : ""

    if (!question.trim()) {
      return NextResponse.json({ error: "Missing question" }, { status: 400 })
    }

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: question,
        },
      ],
      // optional knobs (safe defaults)
      temperature: 0.3,
      max_output_tokens: 500,
    })

    // ✅ v6-safe: don't index into response.output (union type)
    const text = (response.output_text ?? "").trim()

    return NextResponse.json({
      answer: text || "I couldn't generate an answer for that.",
    })
  } catch (err: any) {
    // Useful server logs
    console.error("AI route error:", err?.message || err, err)

    // If OpenAI returns structured errors, surface a little more detail (still safe)
    const detail =
      err?.error?.message ||
      err?.response?.data?.error?.message ||
      err?.message ||
      "OpenAI request failed"

    return NextResponse.json({ error: detail }, { status: 500 })
  }
}
