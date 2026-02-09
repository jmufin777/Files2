import { NextResponse } from "next/server";
import { Pool } from "pg";

export const runtime = "nodejs";

type OrdersByStateResult = {
  byState: Array<{ state: string; count: number }>;
  filesUsed: number;
  rowsUsed: number;
  rowsSkipped: number;
  usedUniqueOrderIds: boolean;
  notes: string[];
};

type OrdersRequest = {
  secretWord?: string;
  maxRows?: number;
};

function detectCsvDelimiter(headerLine: string): "," | ";" | "\t" {
  const comma = (headerLine.match(/,/g) ?? []).length;
  const semicolon = (headerLine.match(/;/g) ?? []).length;
  const tab = (headerLine.match(/\t/g) ?? []).length;
  if (semicolon >= comma && semicolon >= tab) return ";";
  if (tab >= comma && tab >= semicolon) return "\t";
  return ",";
}

function looksLikeDelimitedText(text: string): boolean {
  if (!text) return false;
  const lineBreaks = (text.match(/\n/g) ?? []).length;
  if (lineBreaks < 2) return false;
  return text.includes(",") || text.includes(";") || text.includes("\t");
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === delimiter) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out;
}

function normalizeHeaderToken(token: string): string {
  return token
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9_]/g, "");
}

function findHeaderIndex(headerFields: string[], candidates: string[]): number {
  const normalizedHeader = headerFields.map(normalizeHeaderToken);
  const normalizedCandidates = candidates.map(normalizeHeaderToken);
  for (let i = 0; i < normalizedHeader.length; i += 1) {
    const h = normalizedHeader[i];
    if (!h) continue;
    if (normalizedCandidates.includes(h)) return i;
  }
  return -1;
}

export async function POST(request: Request) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return NextResponse.json(
      { error: "DATABASE_URL not configured." },
      { status: 500 }
    );
  }

  const payload = (await request.json()) as OrdersRequest;
  const orderIdCandidates = [
    "orderid",
    "order_id",
    "objednavkaid",
    "objednavka_id",
    "id",
  ];
  const stateCandidates = [
    "state",
    "stat",
    "country",
    "countrycode",
    "country_code",
    "shipstate",
    "ship_state",
    "deliverystate",
    "delivery_state",
  ];

  const notes: string[] = [];
  const countByState = new Map<string, number>();
  const setsByState = new Map<string, Set<string>>();
  const headerCache = new Map<
    string,
    { delimiter: string; orderIdx: number; stateIdx: number }
  >();
  const MAX_UNIQUE_PER_STATE = 200_000;
  let usedUniqueOrderIds = true;
  let filesUsed = 0;
  let rowsUsed = 0;
  let rowsSkipped = 0;
  const seenSources = new Set<string>();

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const like = payload.secretWord ? `${payload.secretWord}:%` : null;
    const whereClause = like ? "WHERE metadata->>'source' LIKE $1" : "";
    const batchSize = 1000;
    let offset = 0;
    let totalRowsProcessed = 0;

    while (true) {
      const params: Array<string | number> = like ? [like, batchSize, offset] : [batchSize, offset];
      const query = `
        SELECT text, metadata->>'source' AS source
        FROM file_index
        ${whereClause}
        ORDER BY metadata->>'source'
        LIMIT $${like ? 2 : 1} OFFSET $${like ? 3 : 2}
      `;
      const res = await pool.query<{ text: string; source: string | null }>(
        query,
        params
      );

      if (res.rows.length === 0) break;

      for (const row of res.rows) {
        const source = row.source ?? "unknown";
        const content = row.text ?? "";
        if (!content) continue;

        const isLikelyCsv =
          /\.(csv|tsv)(\s|$)/i.test(source) || looksLikeDelimitedText(content);
        if (!isLikelyCsv) continue;

        const lines = content
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        if (lines.length < 2) continue;

        let cached = headerCache.get(source);
        if (!cached) {
          const headerLine = lines[0] ?? "";
          const delimiter = detectCsvDelimiter(headerLine);
          const headerFields = parseCsvLine(headerLine, delimiter);
          const orderIdx = findHeaderIndex(headerFields, orderIdCandidates);
          const stateIdx = findHeaderIndex(headerFields, stateCandidates);
          cached = { delimiter, orderIdx, stateIdx };
          headerCache.set(source, cached);
        }

        const { delimiter, orderIdx, stateIdx } = cached;
        if (orderIdx < 0 || stateIdx < 0) {
          rowsSkipped += lines.length - 1;
          continue;
        }

        seenSources.add(source);
        for (let i = 1; i < lines.length; i += 1) {
          const line = lines[i];
          if (!line) continue;
          const fields = parseCsvLine(line, delimiter);
          const orderId = (fields[orderIdx] ?? "").trim();
          const state = (fields[stateIdx] ?? "").trim() || "Unknown";

          if (!orderId) {
            rowsSkipped += 1;
            continue;
          }

          rowsUsed += 1;

          const stateKey = state.toUpperCase();
          let set = setsByState.get(stateKey);
          if (!set) {
            set = new Set<string>();
            setsByState.set(stateKey, set);
          }

          if (set.size < MAX_UNIQUE_PER_STATE) {
            set.add(orderId);
          } else if (!set.has(orderId)) {
            // Fallback: count rows without deduplication
            countByState.set(stateKey, (countByState.get(stateKey) ?? 0) + 1);
            usedUniqueOrderIds = false;
          }
        }
      }

      totalRowsProcessed += res.rows.length;
      offset += batchSize;

      if (payload.maxRows && totalRowsProcessed >= payload.maxRows) {
        notes.push(`Reached maxRows limit: ${payload.maxRows}`);
        break;
      }
    }

    filesUsed = seenSources.size;

    // Aggregate unique orderIds per state
    for (const [stateKey, set] of setsByState.entries()) {
      const existing = countByState.get(stateKey) ?? 0;
      countByState.set(stateKey, existing + set.size);
    }

    if (countByState.size === 0 && filesUsed === 0) {
      notes.push("No CSV/TSV files with state data found in index.");
    } else if (countByState.size === 0) {
      notes.push(
        `Analyzed ${filesUsed} CSV/TSV files, but found no valid state data.`
      );
    }

    const byState = Array.from(countByState.entries())
      .map(([state, count]) => ({ state, count }))
      .sort((a, b) => b.count - a.count);

    if (!usedUniqueOrderIds) {
      notes.push(
        "Some states exceeded unique orderId limit; hybrid counting used (deduplicated + row count)."
      );
    }

    notes.push(
      "Analyza je z indexovanych chunku. Pro maximalni presnost doporucuji reindex z primarnich CSV"
    );

    return NextResponse.json<OrdersByStateResult>({
      byState,
      filesUsed,
      rowsUsed,
      rowsSkipped,
      usedUniqueOrderIds,
      notes,
    });
  } catch (error) {
    console.error("Orders by state error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Analysis failed." },
      { status: 500 }
    );
  } finally {
    await pool.end();
  }
}
