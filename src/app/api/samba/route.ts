import { NextResponse } from "next/server";
import { readdirSync, statSync } from "fs";
import { join } from "path";

export const runtime = "nodejs";

type SambaRequest = {
  sambaPath: string;
  recursive?: boolean;
  extensions?: string[];
  maxDepth?: number;
  maxFiles?: number;
  nameFilter?: string; // "docx, !eon" - comma-separated, ! prefix for exclusion
  maxDays?: number; // modified in last X days (0 = all)
};

type SambaResponse = {
  success?: boolean;
  sambaPath?: string;
  files?: Array<{
    path: string;
    name: string;
    size: number;
    type: "file" | "directory";
    modified: string;
    created?: string;
  }>;
  suggestedPaths?: Array<{
    path: string;
    name: string;
  }>;
  stats?: {
    totalFiles: number;
    totalDirectories: number;
    totalSize: number;
    totalSizeGB: string;
    scannedLimit: boolean;
  };
  error?: string;
  hint?: string;
};

export async function POST(request: Request) {
  let payload: SambaRequest = {
    sambaPath: "",
    recursive: true,
    maxFiles: 5000,
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
    extensions,
    maxDepth = 25,
    maxFiles = 5000,
    nameFilter = "",
    maxDays = 0,
  } = payload;

  // Podpora jednoduché masky v poli na konci cesty, např. "/mnt/share [pdf]" nebo "/mnt/share [pdf, docx]"
  let effectiveSambaPath = sambaPath;
  let effectiveExtensions = extensions;
  const inlineMaskMatch = sambaPath.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
  if (!effectiveExtensions && inlineMaskMatch) {
    const [, rawPath, maskContent] = inlineMaskMatch;
    effectiveSambaPath = rawPath.trim();
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

  // Pokus se zjistit, jestli cesta existuje
  // Pokud ne, zkus hledat podle prefixu nebo wildcardu
  let pathExists = false;
  let effectivePathToScan = effectiveSambaPath;

  try {
    const st = statSync(effectiveSambaPath);
    pathExists = st.isDirectory();
  } catch {
    pathExists = false;
  }

  // Pokud cesta neexistuje, zkus najít prefix-matched directories nebo wildcard match
  if (!pathExists) {
    const hasWildcard = effectiveSambaPath.includes("*") || effectiveSambaPath.includes("?");
    
    if (hasWildcard) {
      // Glob pattern - najdi poslední jasný segment
      const lastSlash = effectiveSambaPath.lastIndexOf("/");
      const parentPath = lastSlash > 0 ? effectiveSambaPath.substring(0, lastSlash) : "/";
      const pattern = lastSlash > 0 ? effectiveSambaPath.substring(lastSlash + 1) : effectiveSambaPath;

      try {
        const parentStat = statSync(parentPath);
        if (parentStat.isDirectory()) {
          // Konvertuj glob pattern na regex
          const regexPattern = pattern
            .replace(/\./g, "\\.")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".");
          const matcher = new RegExp(`^${regexPattern}$`, "i");

          const entries = readdirSync(parentPath);
          const suggestedPaths: Array<{ path: string; name: string }> = [];

          for (const entry of entries) {
            if (matcher.test(entry)) {
              const fullPath = join(parentPath, entry);
              try {
                const stat = statSync(fullPath);
                suggestedPaths.push({
                  path: fullPath,
                  name: entry,
                });
              } catch {
                // skip
              }
            }
          }

          if (suggestedPaths.length > 0) {
            return NextResponse.json({
              success: true,
              sambaPath: effectiveSambaPath,
              suggestedPaths: suggestedPaths.sort((a, b) =>
                a.name.localeCompare(b.name)
              ),
              error: `Nalezeno ${suggestedPaths.length} položek podle vzoru "${pattern}":`,
            } as SambaResponse);
          } else {
            return NextResponse.json(
              {
                error: `Žádné položky nesouhlasí s vzorem: ${pattern}`,
              } as SambaResponse,
              { status: 400 }
            );
          }
        }
      } catch {
        return NextResponse.json(
          {
            error: `Nadřazená cesta neexistuje: ${parentPath}`,
          } as SambaResponse,
          { status: 400 }
        );
      }
    } else {
      // Prefix matching (bez wildcardu)
      const lastSlash = effectiveSambaPath.lastIndexOf("/");
      if (lastSlash > 0) {
        const parentPath = effectiveSambaPath.substring(0, lastSlash);
        const prefix = effectiveSambaPath.substring(lastSlash + 1).toLowerCase();

        try {
          const parentStat = statSync(parentPath);
          if (parentStat.isDirectory()) {
            const entries = readdirSync(parentPath);
            const suggestedPaths: Array<{ path: string; name: string }> = [];

            for (const entry of entries) {
              if (entry.toLowerCase().startsWith(prefix)) {
                const fullPath = join(parentPath, entry);
                try {
                  const stat = statSync(fullPath);
                  suggestedPaths.push({
                    path: fullPath,
                    name: entry,
                  });
                } catch {
                  // skip
                }
              }
            }

            if (suggestedPaths.length > 0) {
              return NextResponse.json({
                success: true,
                sambaPath: effectiveSambaPath,
                suggestedPaths: suggestedPaths.sort((a, b) =>
                  a.name.localeCompare(b.name)
                ),
                error: `Cesta neexistuje. Návrhy pro prefix "${prefix}":`,
              } as SambaResponse);
            }
          }
        } catch {
          // fall through to error
        }
      }
    }

    return NextResponse.json(
      {
        error: `Cannot access sambaPath: ${effectiveSambaPath}`,
        hint: "Use wildcard pattern (e.g., /mnt/dc03/*office*) or partial path (e.g., /mnt/dc03/c)",
      } as SambaResponse,
      { status: 400 }
    );
  }

  // Cesta existuje, pokračuj s normalním skene

  // Parse name filter
  const includePatterns: Array<{ pattern: RegExp; exclude: boolean }> = [];
  if (nameFilter.trim()) {
    const parts = nameFilter.split(",").map((p) => p.trim());
    for (const part of parts) {
      if (!part) continue;
      const exclude = part.startsWith("!");
      const cleanPart = exclude ? part.slice(1).trim() : part;
      // Convert * to .* for simple glob matching
      const regexStr = cleanPart
        .replace(/\./g, "\\.")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      includePatterns.push({
        pattern: new RegExp(regexStr, "i"),
        exclude,
      });
    }
  }

  // Calculate cutoff time for maxDays
  const now = new Date();
  const cutoffTime = maxDays > 0 ? new Date(now.getTime() - maxDays * 24 * 60 * 60 * 1000) : null;

  // Helper function to check if filename matches filters
  function matchesFilters(filename: string): boolean {
    if (includePatterns.length === 0) return true;

    // Apply filters
    for (const { pattern, exclude } of includePatterns) {
      const matches = pattern.test(filename);
      if (exclude && matches) return false; // Exclusion pattern matched - reject
      if (!exclude && !matches) return false; // Inclusion pattern didn't match - reject
    }
    return true;
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

    let fileCount = 0;

    function scanDirectory(
      dir: string,
      prefix: string = "",
      depth: number = 0
    ): void {
      if (fileCount >= maxFiles) return;
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
          if (fileCount >= maxFiles) break;

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

            const normalizedExtensions = Array.isArray(extensions)
              ? extensions
                  .map((e) => e.toLowerCase().replace(/^\./, ""))
                  .filter((e) => e !== "*" && e !== "")
              : null;

            const isAllowedType = SUPPORTED_TYPES.includes(ext);
            const isRequestedType = normalizedExtensions
              ? normalizedExtensions.includes(ext)
              : true;

            // Check name filters
            const matchesName = matchesFilters(entry);

            // Check date filter
            const isWithinDays = !cutoffTime || stat.mtime > cutoffTime;

            if (isAllowedType && isRequestedType && matchesName && isWithinDays) {
              files.push({
                path: fullPath,
                name: relativePath,
                size: stat.size,
                type: "file",
                modified: new Date(stat.mtime).toISOString(),
                created: new Date(stat.birthtime).toISOString(),
              });
              fileCount++;
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
        scannedLimit: fileCount >= maxFiles,
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
