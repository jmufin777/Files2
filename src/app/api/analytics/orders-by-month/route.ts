import { NextResponse } from "next/server";
import { Pool } from "pg";

export const runtime = "nodejs";

type OrdersByMonthResult = {
  byMonth: Array<{ ym: string; count: number }>;
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

function parseYearMonth(value: string): string | null {
  const v = value.trim();
  if (!v) return null;

  const iso = v.match(/\b(\d{4})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}`;

  const cz = v.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (cz) {
    const month = String(Math.max(1, Math.min(12, Number(cz[2]) || 0))).padStart(2, "0");
    return `${cz[3]}-${month}`;
  }

  const slash = v.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const year = slash[3];
    const monthNum = a > 12 ? b : a;
    const month = String(Math.max(1, Math.min(12, monthNum || 0))).padStart(2, "0");
    return `${year}-${month}`;
  }

  const t = Date.parse(v);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    if (year >= 1970 && year <= 2100) return `${year}-${month}`;
  }

  return null;
}

export async function POST(request: Request) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return NextResponse.json(
      { error: "Missing DATABASE_URL." },
      { status: 500 }
    );
  }

  let payload: OrdersRequest = {};
  try {
    payload = (await request.json()) as OrdersRequest;
  } catch {
    payload = {};
  }

  const orderIdCandidates = [
    "orderid",
    "order_id",
    "ordernumber",
    "order_number",
    "objednavkaid",
    "objednavka_id",
    "idobjednavky",
  ];
  const dateCandidates = [
    "date",
    "datum",
    "orderdate",
    "order_date",
    "createdat",
    "created_at",
    "timestamp",
    "time",
    "order_time",
  ];

  const notes: string[] = [];
  const countByMonth = new Map<string, number>();
  const setsByMonth = new Map<string, Set<string>>();
  const headerCache = new Map<
    string,
    { delimiter: string; orderIdx: number; dateIdx: number }
  >();
  const MAX_UNIQUE_PER_MONTH = 200_000;
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
          .replace(/\r\n?/g, "\n")
          .split("\n")
          .filter((l) => l.trim().length > 0);

        if (lines.length === 0) continue;

        let cached = headerCache.get(source) ?? null;
        let delimiter = cached?.delimiter ?? null;
        let orderIdx = cached?.orderIdx ?? -1;
        let dateIdx = cached?.dateIdx ?? -1;
        let startIndex = 0;

        if (!cached) {
          if (lines.length < 2) continue;
          delimiter = detectCsvDelimiter(lines[0]);
          const headerFields = parseCsvLine(lines[0], delimiter);
          if (headerFields.length < 2) continue;
          orderIdx = findHeaderIndex(headerFields, orderIdCandidates);
          dateIdx = findHeaderIndex(headerFields, dateCandidates);
          if (dateIdx < 0) continue;
          headerCache.set(source, { delimiter, orderIdx, dateIdx });
          cached = { delimiter, orderIdx, dateIdx };
          startIndex = 1;
        } else if (delimiter) {
          const maybeHeader = parseCsvLine(lines[0], delimiter);
          const maybeDateIdx = findHeaderIndex(maybeHeader, dateCandidates);
          if (maybeDateIdx >= 0) {
            orderIdx = findHeaderIndex(maybeHeader, orderIdCandidates);
            dateIdx = maybeDateIdx;
            headerCache.set(source, { delimiter, orderIdx, dateIdx });
            startIndex = 1;
          }
        }

        if (dateIdx < 0) continue;

        if (!seenSources.has(source)) {
          seenSources.add(source);
          filesUsed += 1;
        }

        for (let i = startIndex; i < lines.length; i += 1) {
          const rowFields = parseCsvLine(lines[i], delimiter ?? ",");
          const dateVal = (rowFields[dateIdx] ?? "").trim();
          const ym = parseYearMonth(dateVal);
          if (!ym) {
            rowsSkipped += 1;
            continue;
          }

          if (orderIdx >= 0 && usedUniqueOrderIds) {
            const orderId = (rowFields[orderIdx] ?? "").trim();
            if (!orderId) {
              rowsSkipped += 1;
              continue;
            }
            let set = setsByMonth.get(ym);
            if (!set) {
              set = new Set<string>();
              setsByMonth.set(ym, set);
            }
            set.add(orderId);
            if (set.size > MAX_UNIQUE_PER_MONTH) {
              usedUniqueOrderIds = false;
              notes.push(
                `Mesic ${ym} prekrocil ${MAX_UNIQUE_PER_MONTH} unikatnich orderId; prepinam na pocitani radku.`
              );
              setsByMonth.clear();
            }
          } else {
            countByMonth.set(ym, (countByMonth.get(ym) ?? 0) + 1);
          }
          rowsUsed += 1;
        }

        totalRowsProcessed += 1;
        if (payload.maxRows && totalRowsProcessed >= payload.maxRows) {
          notes.push("Dosazen limit maxRows; vysledek je zkraceny.");
          break;
        }
      }

      if (payload.maxRows && totalRowsProcessed >= payload.maxRows) break;

      offset += res.rows.length;
    }

    if (usedUniqueOrderIds) {
      for (const [ym, set] of setsByMonth.entries()) {
        countByMonth.set(ym, set.size);
      }
    }

    const byMonth = Array.from(countByMonth.entries())
      .map(([ym, count]) => ({ ym, count }))
      .sort((a, b) => a.ym.localeCompare(b.ym));

    if (filesUsed === 0) {
      notes.push(
        "Nenasel jsem CSV/TSV se sloupcem pro datum. Overte, ze soubory obsahuji hlavicku a sloupec datum/order_date."
      );
    } else if (byMonth.length === 0) {
      notes.push(
        "Nepodarilo se vyparsovat zadna platna data (rok-mesic)."
      );
    }

    notes.push(
      "Analyza je z indexovanych chunku. Pro maximalni presnost doporucuji reindex z primarnich CSV/TSV souboru."
    );

    const result: OrdersByMonthResult = {
      byMonth,
      filesUsed,
      rowsUsed,
      rowsSkipped,
      usedUniqueOrderIds,
      notes,
    };

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Orders analysis failed.",
      },
      { status: 500 }
    );
  } finally {
    await pool.end();
  }
}
