import { NextResponse } from "next/server";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";
import { Pool } from "pg";
import { createHash } from "crypto";

export const runtime = "nodejs";

const VECTOR_TABLE_NAME = "file_index";
const modelDimCache = new Map<string, number>();

type IndexRequest = {
  files: Array<{
    name: string;
    content: string;
  }>;
  incremental?: boolean;
};

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

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

    class CheckedEmbeddings extends GoogleGenerativeAIEmbeddings {
      async embedDocuments(texts: string[]): Promise<number[][]> {
        const vectors = await super.embedDocuments(texts);
        // The embedding API can occasionally return empty vectors even for non-empty text.
        // We do not throw here; the caller filters out empty vectors to keep indexing resilient.
        return vectors;
      }

      async embedQuery(text: string): Promise<number[]> {
        const vector = await super.embedQuery(text);
        if (!Array.isArray(vector) || vector.length === 0) {
          const textLen = text?.length ?? 0;
          throw new Error(
            `Embedding returned an empty vector for query (text length: ${textLen}).`
          );
        }
        return vector;
      }
    }

    // Initialize embeddings (with validation)
    const targetDim = await getVectorColumnDimension(pool);
    const embeddingModel = await resolveEmbeddingModel(
      process.env.GEMINI_EMBEDDING_MODEL,
      targetDim
    );
    const embeddings = new CheckedEmbeddings({
      apiKey,
      modelName: embeddingModel,
    });

    // Process all files and create documents
    const documents: Array<{
      pageContent: string;
      metadata: {
        source: string;
        indexed_at: string;
        file_hash: string;
        line_count?: number;
        file_size?: number;
      };
    }> = [];
    const skippedFiles: Array<{ name: string; reason: string }> = [];
    let totalChunks = 0;
    let skippedEmptyChunks = 0;

    const preparedFiles: Array<{ name: string; content: string; fileHash: string }> = [];
    for (const file of payload.files) {
      try {
        const rawContent = typeof file.content === "string" ? file.content : "";
        const content = rawContent.replace(/\u0000/g, "");
        if (content.trim().length === 0) {
          skippedFiles.push({ name: file.name, reason: "empty_content" });
          continue;
        }
        preparedFiles.push({
          name: file.name,
          content,
          fileHash: sha256Hex(content),
        });
      } catch (error) {
        console.warn(`Failed to pre-process file ${file.name}:`, error);
        skippedFiles.push({
          name: file.name,
          reason: error instanceof Error ? error.message : "preprocess_failed",
        });
      }
    }

    if (preparedFiles.length === 0) {
      return NextResponse.json(
        { error: "No documents could be processed." },
        { status: 400 }
      );
    }

    const fileNames = preparedFiles.map((f) => f.name);
    const existingHashBySource = new Map<string, string>();
    if (payload.incremental) {
      try {
        const existing = await pool.query(
          `
            SELECT
              metadata->>'source' AS source,
              MAX(metadata->>'file_hash') AS file_hash
            FROM ${VECTOR_TABLE_NAME}
            WHERE metadata->>'source' = ANY($1)
            GROUP BY 1
          `,
          [fileNames]
        );
        for (const row of existing.rows as Array<{ source: string; file_hash: string | null }>) {
          if (row?.source && row.file_hash) {
            existingHashBySource.set(row.source, row.file_hash);
          }
        }
      } catch {
        // Table might not exist yet (or older rows might miss file_hash). Proceed without skipping.
      }
    }

    const filesToIndex: Array<{ name: string; content: string; fileHash: string }> = [];
    for (const file of preparedFiles) {
      const existingHash = payload.incremental
        ? existingHashBySource.get(file.name)
        : undefined;
      if (payload.incremental && existingHash && existingHash === file.fileHash) {
        skippedFiles.push({ name: file.name, reason: "unchanged" });
        continue;
      }
      filesToIndex.push(file);
    }

    // If everything is unchanged, succeed fast without embedding.
    if (filesToIndex.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No changes detected. Nothing to index.",
        filesCount: payload.files.length,
        chunksCount: 0,
        totalChunksBeforeFiltering: 0,
        skippedEmptyChunks,
        skippedFiles,
        mode: payload.incremental ? "incremental" : "full",
      });
    }

    // If incremental mode, delete old chunks from changed files only.
    if (payload.incremental) {
      const changedNames = filesToIndex.map((f) => f.name);
      try {
        await pool.query(
          `DELETE FROM ${VECTOR_TABLE_NAME} WHERE metadata->>'source' = ANY($1)`,
          [changedNames]
        );
      } catch {
        // Table might not exist yet, that's OK
      }
    }

    for (const file of filesToIndex) {
      try {
        const chunks = await splitter.splitText(file.content);
        totalChunks += chunks.length;

        const indexedAt = new Date().toISOString();
        const lineCount = file.content.split('\n').length;
        const fileSize = file.content.length;
        
        let fileHasAnyChunk = false;
        for (const chunk of chunks) {
          const trimmedChunk = chunk.trim();
          if (trimmedChunk.length === 0) {
            skippedEmptyChunks += 1;
            continue;
          }
          fileHasAnyChunk = true;
          documents.push({
            pageContent: trimmedChunk,
            metadata: {
              source: file.name,
              indexed_at: indexedAt,
              file_hash: file.fileHash,
              line_count: lineCount,
              file_size: fileSize,
            },
          });
        }
        if (!fileHasAnyChunk) {
          skippedFiles.push({ name: file.name, reason: "all_chunks_empty" });
        }
      } catch (error) {
        console.warn(`Failed to process file ${file.name}:`, error);
        skippedFiles.push({
          name: file.name,
          reason: error instanceof Error ? error.message : "processing_failed",
        });
        // Continue with other files
      }
    }

    if (documents.length === 0) {
      return NextResponse.json(
        { error: "No documents could be processed." },
        { status: 400 }
      );
    }

    // Best-effort: compute the embedding dimension for visibility/debugging.
    // (This also provides a quick fail-fast path if the embedding service returns empty vectors.)
    const embeddingDimension = (await embeddings.embedQuery("dimension_check")).length;

    // Embed + filter out any empty vectors before inserting (prevents "vector must have at least 1 dimension").
    const vectors = await embeddings.embedDocuments(
      documents.map((d) => d.pageContent)
    );
    const filteredVectors: number[][] = [];
    const filteredDocuments: typeof documents = [];
    let skippedBadEmbeddings = 0;
    for (let i = 0; i < vectors.length; i += 1) {
      const vector = vectors[i];
      if (Array.isArray(vector) && vector.length > 0) {
        filteredVectors.push(vector);
        filteredDocuments.push(documents[i]);
      } else {
        skippedBadEmbeddings += 1;
      }
    }

    if (filteredDocuments.length === 0) {
      return NextResponse.json(
        {
          error:
            "Embedding service returned empty vectors for all chunks; nothing could be indexed. Try re-running, or reduce/clean input files.",
        },
        { status: 502 }
      );
    }

    // Store in PostgreSQL with pgvector
    const store = await PGVectorStore.initialize(embeddings, {
      pool,
      tableName: VECTOR_TABLE_NAME,
    });
    await store.addVectors(filteredVectors, filteredDocuments);

    return NextResponse.json({
      success: true,
      message: `Indexed ${filteredDocuments.length} chunks from ${payload.files.length} files.`,
      filesCount: payload.files.length,
      chunksCount: filteredDocuments.length,
      embeddingDimension,
      totalChunksBeforeFiltering: totalChunks,
      skippedEmptyChunks,
      skippedFiles,
      skippedBadEmbeddings,
      mode: payload.incremental ? "incremental" : "full",
    });
  } catch (error) {
    console.error("Indexing error:", error);
    const message = error instanceof Error ? error.message : "Indexing failed.";
    const status = message.startsWith("EMBEDDING_DIM_MISMATCH:") ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  } finally {
    await pool.end();
  }
}
