import { NextResponse } from "next/server";
import { Pool } from "pg";

export const runtime = "nodejs";

const VECTOR_TABLE_NAME = "file_index";

export async function POST(request: Request) {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return NextResponse.json(
      { success: false, error: "DATABASE_URL not configured." },
      { status: 500 }
    );
  }

  try {
    const body = await request.json();
    const { prefix } = body as { prefix?: string };

    if (!prefix || typeof prefix !== "string") {
      return NextResponse.json(
        { success: false, error: "Missing or invalid prefix parameter." },
        { status: 400 }
      );
    }

    const pool = new Pool({ connectionString: databaseUrl });

    try {
      // Delete all rows where source starts with the prefix
      const result = await pool.query(
        `DELETE FROM ${VECTOR_TABLE_NAME} WHERE metadata->>'source' LIKE $1`,
        [`${prefix}%`]
      );

      const deletedCount = result.rowCount ?? 0;

      return NextResponse.json({
        success: true,
        message: `Deleted ${deletedCount} records with prefix "${prefix}".`,
        deletedCount,
      });
    } finally {
      await pool.end();
    }
  } catch (error) {
    console.error("Delete by prefix error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Delete failed.",
      },
      { status: 500 }
    );
  }
}
