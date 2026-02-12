import { NextResponse } from "next/server";
import { createReadStream, statSync } from "fs";
import archiver from "archiver";
import { PassThrough, Readable } from "stream";
import path from "path";

export const runtime = "nodejs";

type ZipRequest = {
  paths?: string[];
  zipName?: string;
};

function stripSecretWordPrefix(p: string): string {
  // Our DB sources are stored like: "<secretWord>:/absolute/path".
  // Avoid breaking Windows drive letters (e.g. "C:\\...") by requiring >= 5 chars before ':'.
  const m = /^([^/\\]{5,}):([/\\].*)$/.exec(p);
  return m ? m[2] : p;
}

function safeZipEntryName(filePath: string): string {
  const normalized = path.posix
    .normalize(filePath.replace(/\\/g, "/"))
    .replace(/^([A-Za-z]:)?\/+/, "");

  // Prevent zip-slip: strip any leading ../ segments
  const parts = normalized.split("/").filter((p) => p && p !== "." && p !== "..");
  const joined = parts.join("/");
  return joined.length > 0 ? joined : path.posix.basename(normalized || filePath || "file");
}

export async function POST(request: Request) {
  let payload: ZipRequest;
  try {
    payload = (await request.json()) as ZipRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const paths = Array.isArray(payload.paths)
    ? payload.paths.map((p) => String(p).trim()).filter((p) => p.length > 0)
    : [];

  if (paths.length === 0) {
    return NextResponse.json({ error: "Missing paths." }, { status: 400 });
  }

  // Basic sanity limit to avoid accidental huge ZIPs
  if (paths.length > 500) {
    return NextResponse.json({ error: "Too many files (max 500)." }, { status: 400 });
  }

  const zipNameRaw = typeof payload.zipName === "string" ? payload.zipName.trim() : "";
  const zipName = zipNameRaw.length > 0 ? zipNameRaw.replace(/[^a-zA-Z0-9._-]+/g, "_") : "selected-files";

  const pass = new PassThrough();
  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.on("error", (err) => {
    pass.destroy(err);
  });

  archive.pipe(pass);

  let added = 0;
  const skipped: string[] = [];

  for (const filePath of paths) {
    try {
      const diskPath = stripSecretWordPrefix(filePath);
      const stat = statSync(diskPath);
      if (!stat.isFile()) {
        skipped.push(filePath);
        continue;
      }
      const entryName = safeZipEntryName(diskPath);
      archive.append(createReadStream(diskPath), { name: entryName, stats: stat });
      added += 1;
    } catch {
      // Skip missing/unreadable files
      skipped.push(filePath);
      continue;
    }
  }

  if (added === 0) {
    try {
      archive.destroy();
    } catch {
      // ignore
    }
    pass.destroy();
    return NextResponse.json(
      {
        error:
          "ZIP je prázdný: server nenašel žádný z vybraných souborů (cesty z DB mohou mít prefix secretWord:).",
        requested: paths.length,
        added: 0,
        skipped: skipped.slice(0, 20),
      },
      { status: 400 }
    );
  }

  void archive.finalize();

  return new Response(Readable.toWeb(pass) as unknown as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(zipName)}.zip"`,
    },
  });
}
