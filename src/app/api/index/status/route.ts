import { NextResponse } from "next/server";
import { Pool } from "pg";

export const runtime = "nodejs";

function asNonEmptyString(value: string | null): string | null {
  const v = (value ?? "").trim();
  return v.length > 0 ? v : null;
}

export async function GET(request: Request) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return NextResponse.json(
      { error: "Missing DATABASE_URL." },
      { status: 500 }
    );
  }

  const url = new URL(request.url);
  const contextId = asNonEmptyString(url.searchParams.get("contextId"));

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const existsRes = await pool.query<{
      reg: string | null;
    }>("SELECT to_regclass('public.file_index') AS reg");

    const tableExists = Boolean(existsRes.rows[0]?.reg);
    if (!tableExists) {
      return NextResponse.json({
        tableExists: false,
        hasAnyIndex: false,
        hasContextIndex: false,
      });
    }

    const hasAnyRes = await pool.query<{ has_any: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM file_index LIMIT 1) AS has_any"
    );
    const hasAnyIndex = Boolean(hasAnyRes.rows[0]?.has_any);

    let hasContextIndex = false;
    if (contextId) {
      const like = `${contextId}:%`;
      const ctxRes = await pool.query<{ has_ctx: boolean }>(
        "SELECT EXISTS(\n\tSELECT 1\n\tFROM file_index\n\tWHERE metadata->>'source' LIKE $1\n\tLIMIT 1\n) AS has_ctx",
        [like]
      );
      hasContextIndex = Boolean(ctxRes.rows[0]?.has_ctx);
    }

    return NextResponse.json({
      tableExists: true,
      hasAnyIndex,
      hasContextIndex,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Index status check failed.",
      },
      { status: 500 }
    );
  } finally {
    await pool.end();
  }
}
