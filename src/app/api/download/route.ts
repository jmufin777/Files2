import { NextResponse } from "next/server";
import { createReadStream, statSync } from "fs";
import { basename } from "path";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get("path");

  if (!filePath) {
    return NextResponse.json({ error: "Missing path." }, { status: 400 });
  }

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
