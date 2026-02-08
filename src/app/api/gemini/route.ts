import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const runtime = "nodejs";

type GeminiRequest = {
  message?: string;
  context?: string;
};

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing GEMINI_API_KEY." },
      { status: 500 }
    );
  }

  let payload: GeminiRequest = {};
  try {
    payload = (await request.json()) as GeminiRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!payload.message) {
    return NextResponse.json({ error: "Message is required." }, { status: 400 });
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const modelName = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    const model = genAI.getGenerativeModel({ model: modelName });

    const chartInstruction = `\n\nIf the user asks to show, visualize, chart or graph data, extract the numbers from the context and return a chart block using EXACTLY this format at the end:\n[[CHART]]\n{"title":"<short title>","type":"pie|bar","labels":["A","B"],"series":[10,20]}\n[[/CHART]]\nOnly include the chart block if you have reliable numbers. Keep the rest of the answer in Czech.`;
    const accessInstruction = `\n\nYou have access ONLY to the provided Context text. Never say things like "Nemám přístup k obsahu souborů" or "nemohu spočítat" because you do have access to whatever text is provided. If the provided Context does not include the needed file contents, say in Czech that the provided context is missing the relevant file contents and ask the user to add the relevant files to context.`;

    const prompt = payload.context
      ? `Context:\n${payload.context}\n\nUser:\n${payload.message}${chartInstruction}${accessInstruction}`
      : `${payload.message}${chartInstruction}${accessInstruction}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    return NextResponse.json({ text });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Gemini request failed.",
      },
      { status: 500 }
    );
  }
}
