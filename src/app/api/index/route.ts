import { NextResponse } from "next/server";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";
import { Pool } from "pg";

export const runtime = "nodejs";

type IndexRequest = {
  files: Array<{
    name: string;
    content: string;
  }>;
  incremental?: boolean;
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

  let payload: IndexRequest = { files: [], incremental: true };
  try {
    payload = (await request.json()) as IndexRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!payload.files || payload.files.length === 0) {
    return NextResponse.json(
      { error: "No files provided for indexing." },
      { status: 400 }
    );
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // Initialize text splitter with configurable options
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
      separators: [
        "\n\n",
        "\n",
        " ",
        ",",
        "",
      ],
    });

    // Initialize embeddings
    const embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey,
      modelName: "embedding-001",
    });

    // If incremental mode, delete old chunks from these files first
    if (payload.incremental) {
      const fileNames = payload.files.map((f) => f.name);
      try {
        await pool.query(
          `DELETE FROM file_index WHERE metadata->>'source' = ANY($1)`,
          [fileNames]
        );
      } catch {
        // Table might not exist yet, that's OK
      }
    }

    // Process all files and create documents
    const documents = [];
    let totalChunks = 0;
    for (const file of payload.files) {
      try {
        const chunks = await splitter.splitText(file.content);
        totalChunks += chunks.length;
        for (const chunk of chunks) {
          documents.push({
            pageContent: chunk,
            metadata: { source: file.name, indexed_at: new Date().toISOString() },
          });
        }
      } catch (error) {
        console.warn(`Failed to process file ${file.name}:`, error);
        // Continue with other files
      }
    }

    if (documents.length === 0) {
      return NextResponse.json(
        { error: "No documents could be processed." },
        { status: 400 }
      );
    }

    // Store in PostgreSQL with pgvector
    await PGVectorStore.fromDocuments(documents, embeddings, {
      pool,
      tableName: "file_index",
    });

    return NextResponse.json({
      success: true,
      message: `Indexed ${documents.length} chunks from ${payload.files.length} files.`,
      filesCount: payload.files.length,
      chunksCount: documents.length,
      mode: payload.incremental ? "incremental" : "full",
    });
  } catch (error) {
    console.error("Indexing error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Indexing failed.",
      },
      { status: 500 }
    );
  } finally {
    await pool.end();
  }
}
