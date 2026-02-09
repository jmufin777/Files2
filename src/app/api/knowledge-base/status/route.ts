import { NextResponse } from "next/server";
import { Pool } from "pg";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return NextResponse.json(
      { error: "Missing DATABASE_URL." },
      { status: 500 }
    );
  }

  // Parse query parameters
  const { searchParams } = new URL(request.url);
  const prefix = searchParams.get("prefix") || null;

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // Check if table exists
    const tableCheck = await pool.query<{ reg: string | null }>(
      "SELECT to_regclass('public.file_index') AS reg"
    );
    const tableExists = Boolean(tableCheck.rows[0]?.reg);

    if (!tableExists) {
      return NextResponse.json({
        initialized: false,
        message: "No knowledge base found. Index files first.",
      });
    }

    // Build WHERE clause for prefix filtering
    const whereClause = prefix ? "WHERE metadata->>'source' LIKE $1" : "";
    const queryParams: any[] = prefix ? [`${prefix}%`] : [];

    // Count total chunks
    const chunkCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM file_index ${whereClause}`,
      queryParams
    );
    const totalChunks = parseInt(chunkCount.rows[0]?.count ?? "0", 10);

    // Count unique files
    const fileCount = await pool.query<{ count: string }>(
      `SELECT COUNT(DISTINCT metadata->>'source') as count FROM file_index ${whereClause}`,
      queryParams
    );
    const totalFiles = parseInt(fileCount.rows[0]?.count ?? "0", 10);

    // Get vector dimension
    const dimQuery = await pool.query<{ type: string }>(
      `
        SELECT format_type(a.atttypid, a.atttypmod) AS type
        FROM pg_attribute a
        JOIN pg_class c ON a.attrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE c.relname = 'file_index'
          AND n.nspname = 'public'
          AND a.attname = 'embedding'
          AND a.attnum > 0
          AND NOT a.attisdropped
      `
    );
    let embeddingDimension: number | null = null;
    if (dimQuery.rows.length > 0) {
      const type = dimQuery.rows[0]?.type ?? "";
      const match = /vector\((\d+)\)/.exec(type);
      embeddingDimension = match ? Number(match[1]) : null;
    }

    // Get latest indexed timestamp
    const latestQuery = await pool.query<{ latest: string | null }>(
      `SELECT MAX(metadata->>'indexed_at') as latest FROM file_index ${whereClause}`,
      queryParams
    );
    const lastIndexedAt = latestQuery.rows[0]?.latest ?? null;

    // Get sample sources
    const sourcesQuery = await pool.query<{ source: string }>(
      `
        SELECT DISTINCT metadata->>'source' as source
        FROM file_index
        ${whereClause}
        ORDER BY metadata->>'source'
        LIMIT 10
      `,
      queryParams
    );
    const sampleSources = sourcesQuery.rows.map((row) => row.source);

    return NextResponse.json({
      initialized: true,
      totalFiles,
      totalChunks,
      embeddingDimension,
      lastIndexedAt,
      sampleSources,
      readyForSearch: totalChunks > 0,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Status check failed.",
      },
      { status: 500 }
    );
  } finally {
    await pool.end();
  }
}
