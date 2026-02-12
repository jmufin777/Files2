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
  secretWord?: string; // Tajné slovo pro multi-user izolaci
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
      
      if (payload.secretWord) {
        const prefix = `${payload.secretWord}:%`;
        sqlQuery += " WHERE metadata->>'source' LIKE $1";
        params.push(prefix);
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

    const contextPrefix = payload.secretWord ? `${payload.secretWord}:` : null;
    if (contextPrefix) {
      results = results.filter(
        (row) =>
          typeof row.metadata?.source === "string" &&
          row.metadata.source.startsWith(contextPrefix)
      );
    }

    // Build detailed source metadata (path, line_count, file_size)
    const sourceMetadataMap = new Map<string, { lineCount?: number; fileSize?: number }>();
    for (const doc of results) {
      const sourcePath = doc.metadata.source as string;
      if (!sourceMetadataMap.has(sourcePath)) {
        sourceMetadataMap.set(sourcePath, {
          lineCount: doc.metadata.line_count as number | undefined,
          fileSize: doc.metadata.file_size as number | undefined,
        });
      }
    }

    const allSources = Array.from(sourceMetadataMap.keys());
    const sourcesList = allSources.map((path) => {
      const meta = sourceMetadataMap.get(path);
      return {
        path,
        lineCount: meta?.lineCount,
        fileSize: meta?.fileSize,
      };
    });
    
    // Pokud analyzeOnly=true, vrať jen statistiky bez volání Gemini
    if (payload.analyzeOnly) {
      return NextResponse.json({
        text: `Nalezeno ${results.length} chunků z ${allSources.length} souborů.`,
        relevantChunks: results.length,
        sources: sourcesList,
        analyzedOnly: true,
      });
    }

    // Omez počet chunků posílaných do Gemini (kvůli rate limitu)
    const maxChunks = payload.maxContextChunks || 200;
    const limitedResults = results.slice(0, maxChunks);
    
    // Build context from search results with metadata
    const context = limitedResults
      .map((doc) => {
        const metaInfo = [];
        if (doc.metadata.line_count) metaInfo.push(`lines: ${doc.metadata.line_count}`);
        if (doc.metadata.file_size) metaInfo.push(`size: ${doc.metadata.file_size} bytes`);
        const metaStr = metaInfo.length > 0 ? ` (${metaInfo.join(', ')})` : '';
        return `Source: ${doc.metadata.source}${metaStr}\n${doc.pageContent}`;
      })
      .join("\n\n---\n\n");

    // Generate response with Gemini
    const genAI = new GoogleGenerativeAI(apiKey);
    const modelName = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    const model = genAI.getGenerativeModel({ model: modelName });

    const chartInstruction = `\n\nIf the user asks to show, visualize, chart or graph data, extract the numbers from the documents and return a chart block using EXACTLY this format at the end:\n[[CHART]]\n{"title":"<short title>","type":"pie|bar|line","labels":["A","B"],"series":[10,20]}\n[[/CHART]]\nOnly include the chart block if you have reliable numbers. Keep the rest of the answer in Czech.`;
    const wantsStructured = /(strukturov|structured|prehled|přehled)/i.test(
      payload.query
    );
    const wantsFullContextTab = /(zalozk|zalozku|cely\s+kontext|celý\s+kontext)/i.test(
      payload.query
    );
    const structuredInstruction = wantsStructured
      ? `\n\nThe user explicitly wants structured results. You MUST include a structured results block at the end using EXACTLY this format (even if you already wrote prose):\n[[STRUCTURED]]\n{"groups":[{"client":"CategoryName","files":[{"path":"path/to/file.xlsx","description":"Brief description"}]}],"summary":"Brief summary"}\n[[/STRUCTURED]]\nGroup files into sensible categories based on the documents. In the files array, include relevant file paths from the Documents. If no files are found, return an empty groups array and explain in the summary. Keep descriptions brief and in Czech.`
      : `\n\nIf the user asks about finding files for specific clients or entities (e.g., "mám klienta colonnade a helvetia"), organize your response to include a structured results block at the end using EXACTLY this format:\n[[STRUCTURED]]\n{"groups":[{"client":"ClientName","files":[{"path":"path/to/file.xlsx","description":"Brief description"}]}],"summary":"Brief summary"}\n[[/STRUCTURED]]\nIn the files array, include all relevant file paths from the Documents that belong to each client. Keep descriptions brief and in Czech.`;
    const fullContextInstruction = wantsFullContextTab
      ? `\n\nThe user explicitly asked for a full-context tab. In the structured results, add a group with client "Cely kontext" that lists ONLY the file paths from the Sources list below. Do not add any other paths. Use brief Czech descriptions like "Soubor z kontextu".`
      : "";
    const accessInstruction = `\n\nYou have access ONLY to the provided Documents text. Never say things like "Nemám přístup k obsahu souborů" or "nemohu spočítat" because you can access the provided Documents. If the Documents do not contain the needed information, say in Czech that the provided documents are insufficient and ask the user to add the relevant files to context.\n\nIMPORTANT: Each document chunk contains metadata including 'line_count' (total lines in original file) and 'file_size' (bytes). When asked about statistics like "kolik mají celkem řádků" (how many lines total), you MUST:\n1. Identify all unique source files from the documents\n2. For each unique file, extract the line_count from metadata (it's the same for all chunks from one file)\n3. Sum up the line_count values for all unique files\n4. Present the result in Czech with details per file if helpful.`;
    
    const contextCounts = (() => {
      let totalLines = 0;
      let totalSizeBytes = 0;
      // Sum per unique source to avoid counting the same file multiple times.
      for (const source of allSources) {
        const meta = sourceMetadataMap.get(source);
        if (meta?.lineCount) totalLines += meta.lineCount;
        if (meta?.fileSize) totalSizeBytes += meta.fileSize;
      }
      return { files: allSources.length, totalLines, totalSizeBytes };
    })();

    const contextCountsInstruction = `\n\nIMPORTANT: When the user asks a question in Czech about the NUMBER/COUNT of files in the context, you must recognize patterns like:
- Questions containing "kolik" (how many) + any form of "soubor" (file) + "kontext" (context)
- This includes ALL grammatical variations: "souboru", "souborů", "soubory", "soubor"
- Examples: "kolik je souboru", "kolik je souborů", "kolik je soubory", "kolik máme souboru", "kolik mame souboru", "kolik mám souboru", "počet souboru", "počet souborů"
  - When you detect such a question, ALWAYS respond with ONLY: "V kontextu máte celkem ${contextCounts.files} souborů. Pro práci jsou připraveny ${contextCounts.files} soubory (výběr z indexu), celkem asi ${contextCounts.totalLines.toLocaleString()} řádků a ${(contextCounts.totalSizeBytes / (1024 * 1024)).toFixed(1)} MB." in Czech. Nothing else - just this answer.`;

    const contextInfo = results.length > maxChunks 
      ? `\n\nIMPORTANT: You are analyzing ${limitedResults.length} chunks out of ${results.length} total chunks from ${allSources.length} files. The analysis is based on a representative sample.`
      : `\n\nYou are analyzing ${results.length} chunks from ${allSources.length} files.`;

    const sourcesTextList = allSources.length
      ? `\n\nSources (${allSources.length} files):\n${allSources.map((source) => `- ${source}`).join("\n")}`
      : "\n\nSources:\n(none)";
    const prompt = `Based on the following documents, answer the query:${contextInfo}${sourcesTextList}\n\nDocuments:\n${context}\n\nQuery: ${payload.query}${chartInstruction}${contextCountsInstruction}${structuredInstruction}${fullContextInstruction}${accessInstruction}`;
    const response = await model.generateContent(prompt);
    const text = response.response.text();

    return NextResponse.json({
      text,
      relevantChunks: results.length,
      chunksUsedInPrompt: limitedResults.length,
      sources: sourcesList,
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
