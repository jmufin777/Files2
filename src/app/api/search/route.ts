import { NextResponse } from "next/server";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Pool } from "pg";

export const runtime = "nodejs";

type SearchRequest = {
  query: string;
  topK?: number;
};

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  const databaseUrl = process.env.DATABASE_URL;

  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing GEMINI_API_KEY." },
      { status: 500 }
    );
  }

  if (!databaseUrl) {
    return NextResponse.json(
      { error: "Missing DATABASE_URL." },
      { status: 500 }
    );
  }

  let payload: SearchRequest = { query: "", topK: 5 };
  try {
    payload = (await request.json()) as SearchRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!payload.query) {
    return NextResponse.json({ error: "Query is required." }, { status: 400 });
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // Initialize embeddings
    const embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey,
      modelName: "embedding-001",
    });

    // Connect to PostgreSQL and search
    const vectorStore = new PGVectorStore(embeddings, {
      pool,
      tableName: "file_index",
    });

    const results = await vectorStore.similaritySearch(
      payload.query,
      payload.topK || 5
    );

    // Build context from search results
    const context = results
      .map((doc) => `Source: ${doc.metadata.source}\n${doc.pageContent}`)
      .join("\n\n---\n\n");

    // Generate response with Gemini
    const genAI = new GoogleGenerativeAI(apiKey);
    const modelName = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    const model = genAI.getGenerativeModel({ model: modelName });

    const chartInstruction = `\n\nIf the user asks to show, visualize, chart or graph data, extract the numbers from the documents and return a chart block using EXACTLY this format at the end:\n[[CHART]]\n{"title":"<short title>","type":"pie|bar","labels":["A","B"],"series":[10,20]}\n[[/CHART]]\nOnly include the chart block if you have reliable numbers. Keep the rest of the answer in Czech.`;
    const accessInstruction = `\n\nYou have access ONLY to the provided Documents text. Do NOT claim you cannot access local files. If the documents are missing or insufficient, ask the user to add the relevant files to context.`;

    const prompt = `Based on the following documents, answer the query:\n\nDocuments:\n${context}\n\nQuery: ${payload.query}${chartInstruction}${accessInstruction}`;
    const response = await model.generateContent(prompt);
    const text = response.response.text();

    return NextResponse.json({
      text,
      relevantChunks: results.length,
      sources: Array.from(new Set(results.map((r) => r.metadata.source))),
    });
  } catch (error) {
    console.error("Search error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Search failed.",
      },
      { status: 500 }
    );
  } finally {
    await pool.end();
  }
}
