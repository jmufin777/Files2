import { NextResponse } from "next/server";
import { Pool } from "pg";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return NextResponse.json(
      { error: "Missing DATABASE_URL." },
      { status: 500 }
    );
  }

  const url = new URL(request.url);
  const mode = (url.searchParams.get("mode") ?? "drop").toLowerCase();
  const isTruncate = mode === "truncate";
  if (mode !== "drop" && !isTruncate) {
    return NextResponse.json(
      { error: "Invalid rebuild mode. Use mode=drop or mode=truncate." },
      { status: 400 }
    );
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    if (isTruncate) {
      await pool.query("TRUNCATE TABLE IF EXISTS file_index");
    } else {
      await pool.query("DROP TABLE IF EXISTS file_index");
    }
    return NextResponse.json({
      success: true,
      message: isTruncate
        ? "Index table truncated. Please reindex your files."
        : "Index table dropped. Please reindex your files.",
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Rebuild failed.",
      },
      { status: 500 }
    );
  } finally {
    await pool.end();
  }
}
