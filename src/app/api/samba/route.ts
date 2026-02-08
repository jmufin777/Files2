import { NextResponse } from "next/server";
import { readdirSync, statSync } from "fs";
import { join } from "path";

export const runtime = "nodejs";

type SambaRequest = {
  sambaPath: string; // např. "/mnt/samba/documents" nebo "\\server\share"
  recursive?: boolean;
  maxFiles?: number;
  extensions?: string[]; // např. ["pdf", "docx"]
  maxDepth?: number;
};

export async function POST(request: Request) {
  let payload: SambaRequest = {
    sambaPath: "",
    recursive: true,
    maxFiles: 1000,
    maxDepth: 25,
  };

  try {
    payload = (await request.json()) as SambaRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const {
    sambaPath,
    recursive = true,
    maxFiles = 1000,
    extensions,
    maxDepth = 25,
  } = payload;

  // Podpora jednoduché masky v poli na konci cesty, např. "/mnt/share [pdf]" nebo "/mnt/share [pdf, docx]"
  let effectiveSambaPath = sambaPath;
  let effectiveExtensions = extensions;
  const inlineMaskMatch = sambaPath.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
  if (!effectiveExtensions && inlineMaskMatch) {
    const [, rawPath, maskContent] = inlineMaskMatch;
    effectiveSambaPath = rawPath.trim();
    // Parse simple comma-separated list (no JSON needed)
    effectiveExtensions = maskContent
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e.length > 0);
  }

  if (!effectiveSambaPath) {
    return NextResponse.json(
      { error: "Missing sambaPath." },
      { status: 400 }
    );
  }

  // Fail fast if the path is invalid or inaccessible.
  try {
    const st = statSync(effectiveSambaPath);
    if (!st.isDirectory()) {
      return NextResponse.json(
        { error: `Samba path is not a directory: ${effectiveSambaPath}` },
        { status: 400 }
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      {
        error: `Cannot access sambaPath: ${effectiveSambaPath}. ${message}`,
        hint:
          "Check that the path exists on the server running Next.js and that it has read permissions (mount + ACL).",
      },
      { status: 500 }
    );
  }

  try {
    const files: Array<{
      path: string;
      name: string;
      size: number;
      type: "file" | "directory";
      modified: string;
      created?: string;
    }> = [];

    function scanDirectory(
      dir: string,
      prefix: string = "",
      depth: number = 0
    ): void {
      if (files.length >= maxFiles) return;
      if (depth > maxDepth) return;

      const SKIP_DIRS = [
        "node_modules",
        ".git",
        "$Recycle.Bin",
        "System Volume Information",
        "Recovery",
        ".~",
        "Library",
        ".cache",
        ".npm",
        ".Trash",
      ];

      try {
        const entries = readdirSync(dir);

        for (const entry of entries) {
          if (files.length >= maxFiles) break;

          if (entry.startsWith(".") || SKIP_DIRS.some((skip) => entry.includes(skip))) {
            continue;
          }

          const fullPath = join(dir, entry);
          const stat = statSync(fullPath);
          const relativePath = prefix ? `${prefix}/${entry}` : entry;

          if (stat.isDirectory()) {
            files.push({
              path: fullPath,
              name: relativePath,
              size: 0,
              type: "directory",
              modified: new Date(stat.mtime).toISOString(),
              created: new Date(stat.birthtime).toISOString(),
            });

            if (recursive) {
              scanDirectory(fullPath, relativePath, depth + 1);
            }
          } else if (stat.isFile()) {
            // Filter pouze office/document soubory + volitelný whitelist z requestu
            const ext = entry.toLowerCase().split(".").pop() ?? "";
            const SUPPORTED_TYPES = [
              "docx",
              "doc",
              "xlsx",
              "xls",
              "csv",
              "pdf",
              "txt",
              "md",
              "pptx",
            ];

            const normalizedExtensions = Array.isArray(effectiveExtensions)
              ? effectiveExtensions
                  .map((e) => e.toLowerCase().replace(/^\./, ""))
                  .filter((e) => e !== "*" && e !== "")
              : null;

            const isAllowedType = SUPPORTED_TYPES.includes(ext);
            const isRequestedType = normalizedExtensions
              ? normalizedExtensions.includes(ext)
              : true;

            if (isAllowedType && isRequestedType) {
              files.push({
                path: fullPath,
                name: relativePath,
                size: stat.size,
                type: "file",
                modified: new Date(stat.mtime).toISOString(),
                created: new Date(stat.birthtime).toISOString(),
              });
            }
          }
        }
      } catch (error) {
        console.warn(
          `Error scanning directory ${dir}:`,
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    }

    scanDirectory(effectiveSambaPath);

    const totalSize = files
      .filter((f) => f.type === "file")
      .reduce((sum, f) => sum + f.size, 0);

    const fileCount = files.filter((f) => f.type === "file").length;
    const dirCount = files.filter((f) => f.type === "directory").length;

    return NextResponse.json({
      success: true,
      sambaPath: effectiveSambaPath,
      files,
      stats: {
        totalFiles: fileCount,
        totalDirectories: dirCount,
        totalSize,
        totalSizeGB: (totalSize / (1024 * 1024 * 1024)).toFixed(2),
        scannedLimit: files.length >= maxFiles,
      },
    });
  } catch (error) {
    console.error("Samba scan error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to scan Samba path.",
        hint:
          "Check that the Samba path is mounted correctly (e.g., /mnt/samba)",
      },
      { status: 500 }
    );
  }
}
