import { NextResponse } from "next/server";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Pool } from "pg";

export const runtime = "nodejs";

const VECTOR_TABLE_NAME = "file_index";
const modelDimCache = new Map<string, number>();

type SearchRequest = {
  query: string;
  topK?: number;
  useAllDocuments?: boolean; // Pokud true, načte všechny dokumenty místo similarity search
  contextId?: string; // Filter podle contextId (např. "samba_abc")
  maxContextChunks?: number; // Maximální počet chunků poslaných do Gemini (kvůli rate limitu)
  analyzeOnly?: boolean; // Pokud true, vrátí jen statistiky bez volání Gemini
};

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  const databaseUrl = process.env.DATABASE_URL;

  async function getVectorColumnDimension(pool: Pool): Promise<number | null> {
    try {
      const result = await pool.query<{ type: string }>(
        `
          SELECT format_type(a.atttypid, a.atttypmod) AS type
          FROM pg_attribute a
          JOIN pg_class c ON a.attrelid = c.oid
          JOIN pg_namespace n ON c.relnamespace = n.oid
          WHERE c.relname = $1
            AND n.nspname = 'public'
            AND a.attname = 'embedding'
            AND a.attnum > 0
            AND NOT a.attisdropped
        `,
        [VECTOR_TABLE_NAME]
      );
      if (result.rows.length === 0) return null;
      const type = result.rows[0]?.type ?? "";
      const match = /vector\((\d+)\)/.exec(type);
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  }

  async function getModelDimension(modelName: string): Promise<number | null> {
    if (modelDimCache.has(modelName)) {
      return modelDimCache.get(modelName) ?? null;
    }
    try {
      const probe = new GoogleGenerativeAIEmbeddings({
        apiKey,
        modelName,
      });
      const vector = await probe.embedQuery("dimension_check");
      const dim = Array.isArray(vector) ? vector.length : null;
      if (dim && dim > 0) {
        modelDimCache.set(modelName, dim);
        return dim;
      }
      return null;
    } catch {
      return null;
    }
  }

  async function resolveEmbeddingModel(
    preferred?: string,
    targetDim?: number | null
  ): Promise<string> {
    const fallback = preferred || "text-embedding-004";
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
        { method: "GET" }
      );
      if (!res.ok) return fallback;
      const data = (await res.json()) as {
        models?: Array<{
          name?: string;
          supportedGenerationMethods?: string[];
        }>;
      };
      const candidates = (data.models || [])
        .filter((m) =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes("embedContent") &&
          typeof m.name === "string"
        )
        .map((m) => m.name as string);

      const normalize = (name: string) => name.replace(/^models\//, "");
      const preferredFull = preferred ? `models/${preferred}` : null;

      const orderedCandidates = [
        ...(preferredFull ? [preferredFull] : []),
        ...candidates,
      ];

      if (targetDim) {
        for (const candidate of orderedCandidates) {
          const normalized = normalize(candidate);
          const dim = await getModelDimension(normalized);
          if (dim === targetDim) {
            return normalized;
          }
        }
        throw new Error(
          `EMBEDDING_DIM_MISMATCH: Existing vectors are ${targetDim}D, but no supported model with embedContent matches this dimension. Reindex with a new table or rebuild embeddings.`
        );
      }

      if (preferredFull && candidates.includes(preferredFull)) {
        return normalize(preferredFull);
      }

      if (candidates.length > 0) {
        return normalize(candidates[0]);
      }

      return fallback;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("EMBEDDING_DIM_MISMATCH:")) {
        throw error;
      }
      return fallback;
    }
  }

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

  let payload: SearchRequest = { 
    query: "", 
    topK: 500, 
    useAllDocuments: false,
    maxContextChunks: 200, // Bezpečný limit pro Gemini
    analyzeOnly: false
  };
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
    let results: Array<{ pageContent: string; metadata: { source: string; [key: string]: any } }> = [];

    // Pokud useAllDocuments=true, načti všechny chunky bez similarity search
    if (payload.useAllDocuments) {
      let sqlQuery = `SELECT content AS pageContent, metadata FROM ${VECTOR_TABLE_NAME}`;
      const params: any[] = [];
      
      if (payload.contextId) {
        sqlQuery += " WHERE metadata->>'source' LIKE $1";
        params.push(`${payload.contextId}:%`);
      }
      
      sqlQuery += " LIMIT 10000"; // Safety limit
      
      const dbResults = await pool.query<{
        text: string;
        metadata: { source: string; [key: string]: any };
      }>(sqlQuery, params);
      
      results = dbResults.rows.map((row) => ({
        pageContent: row.text,
        metadata: row.metadata,
      }));
    } else {
      // Standardní similarity search
      const targetDim = await getVectorColumnDimension(pool);
      const embeddingModel = await resolveEmbeddingModel(
        process.env.GEMINI_EMBEDDING_MODEL,
        targetDim
      );
      const embeddings = new GoogleGenerativeAIEmbeddings({
        apiKey,
        modelName: embeddingModel,
      });

      const vectorStore = new PGVectorStore(embeddings, {
        pool,
        tableName: VECTOR_TABLE_NAME,
      });

      results = (await vectorStore.similaritySearch(
        payload.query,
        payload.topK || 500
      )) as Array<{ pageContent: string; metadata: { source: string; [key: string]: any } }>;
    }

    const allSources = Array.from(new Set(results.map((r) => r.metadata.source)));
    
    // Pokud analyzeOnly=true, vrať jen statistiky bez volání Gemini
    if (payload.analyzeOnly) {
      return NextResponse.json({
        text: `Nalezeno ${results.length} chunků z ${allSources.length} souborů.`,
        relevantChunks: results.length,
        sources: allSources,
        analyzedOnly: true,
      });
    }

    // Omez počet chunků posílaných do Gemini (kvůli rate limitu)
    const maxChunks = payload.maxContextChunks || 200;
    const limitedResults = results.slice(0, maxChunks);
    
    // Build context from search results
    const context = limitedResults
      .map((doc) => `Source: ${doc.metadata.source}\n${doc.pageContent}`)
      .join("\n\n---\n\n");

    // Generate response with Gemini
    const genAI = new GoogleGenerativeAI(apiKey);
    const modelName = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    const model = genAI.getGenerativeModel({ model: modelName });

    const chartInstruction = `\n\nIf the user asks to show, visualize, chart or graph data, extract the numbers from the documents and return a chart block using EXACTLY this format at the end:\n[[CHART]]\n{"title":"<short title>","type":"pie|bar|line","labels":["A","B"],"series":[10,20]}\n[[/CHART]]\nOnly include the chart block if you have reliable numbers. Keep the rest of the answer in Czech.`;
    const accessInstruction = `\n\nYou have access ONLY to the provided Documents text. Never say things like "Nemám přístup k obsahu souborů" or "nemohu spočítat" because you can access the provided Documents. If the Documents do not contain the needed information, say in Czech that the provided documents are insufficient and ask the user to add the relevant files to context.`;
    
    const contextInfo = results.length > maxChunks 
      ? `\n\nIMPORTANT: You are analyzing ${limitedResults.length} chunks out of ${results.length} total chunks from ${allSources.length} files. The analysis is based on a representative sample.`
      : `\n\nYou are analyzing ${results.length} chunks from ${allSources.length} files.`;

    const prompt = `Based on the following documents, answer the query:${contextInfo}\n\nDocuments:\n${context}\n\nQuery: ${payload.query}${chartInstruction}${accessInstruction}`;
    const response = await model.generateContent(prompt);
    const text = response.response.text();

    return NextResponse.json({
      text,
      relevantChunks: results.length,
      chunksUsedInPrompt: limitedResults.length,
      sources: allSources,
    });
  } catch (error) {
    console.error("Search error:", error);
    const message = error instanceof Error ? error.message : "Search failed.";
    const status = message.startsWith("EMBEDDING_DIM_MISMATCH:") ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  } finally {
    await pool.end();
  }
}
