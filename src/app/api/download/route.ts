import { NextResponse } from "next/server";
import { createReadStream, statSync } from "fs";
import { basename } from "path";

export const runtime = "nodejs";

function stripSecretWordPrefix(p: string): string {
  // Our DB sources are stored like: "<secretWord>:/absolute/path".
  // Avoid breaking Windows drive letters (e.g. "C:\\...") by requiring >= 5 chars before ':'.
  const m = /^([^/\\]{5,}):([/\\].*)$/.exec(p);
  return m ? m[2] : p;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawPath = searchParams.get("path");

  if (!rawPath) {
    return NextResponse.json({ error: "Missing path." }, { status: 400 });
  }

  const filePath = stripSecretWordPrefix(rawPath);

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return NextResponse.json(
        { error: `Not a file: ${filePath}` },
        { status: 400 }
      );
    }

    const fileName = basename(filePath);
    const stream = createReadStream(filePath);

    return new Response(stream as unknown as ReadableStream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(stat.size),
        "Content-Disposition": `attachment; filename="${encodeURIComponent(
          fileName
        )}"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Read failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
