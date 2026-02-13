"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import ResultsChart, { type ChartType2D } from "../components/ResultsChart";
import DataTable from "../components/DataTable";
import Plot3D from "../components/Plot3D";

type FileEntry = {
  path: string;
  handle?: FileSystemFileHandle;
  file?: File;
  size: number;
  modified?: string;
};

type SambaEntry = {
  path: string;
  name: string;
  size: number;
  type: "file" | "directory";
  modified?: string;
  created?: string;
};

type SambaStats = {
  totalFiles: number;
  totalDirectories?: number;
  totalSize?: number;
  totalSizeGB?: string;
  scannedLimit?: boolean;
};

type FileContext = {
  path: string;
  content: string;
  size: number;
  lineCount: number;
  modified?: string;
  created?: string;
};

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

type ChatHistoryItem = {
  id: string;
  q: string;
  ok: boolean;
  ts: number;
};

type SpeechRecognitionResultLike = {
  0?: { transcript?: string };
  isFinal?: boolean;
};

type SpeechRecognitionEventLike = {
  results: SpeechRecognitionResultLike[];
};

type SpeechRecognitionInstance = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type FileGroup = {
  client: string;
  files: Array<{
    path: string;
    description?: string;
    size?: number;
  }>;
};

type StructuredResult = {
  groups: FileGroup[];
  summary?: string;
};

type ActiveTab = "chat" | "results" | "files";

type AssistantFileSortBy = "path" | "lines" | "size" | "description";

type ChartType = "pie" | "bar" | "line" | "3d";
type ChartSource = "results" | "samba";
type AssistantChart = {
  title: string;
  type: ChartType2D;
  labels: string[];
  series: number[];
};
type AssistantChart3D = {
  title: string;
  type: "3d";
  data: Array<{ x: number; y: number; z: number; label?: string }>;
  xLabel?: string;
  yLabel?: string;
  zLabel?: string;
};
type AssistantTable = {
  title: string;
  headers: string[];
  rows: (string | number)[][];
};
type AssistantChartItem = (AssistantChart | AssistantChart3D) & {
  id: string;
};
type AssistantTableItem = AssistantTable & {
  id: string;
};
type LoadProgress = {
  label: string;
  percent: number;
};

type SavedFileMeta = {
  modified?: string;
  created?: string;
  size?: number;
  hash?: string;
};

type SavedContext = {
  id: string;
  name: string;
  secretKey: string; // Pro multi-user izolaci a sdílení
  sambaPath: string;
  autoSyncMinutes: number;
  extensions: string[];
  notifyOnSync: boolean;
  lastIndexedAt?: string;
  files: Record<string, SavedFileMeta>;
  uiPaths?: string[];
};

type SecretWordLastSource = "files" | "samba";

type SecretWordSettings = {
  sambaPath: string;
  extensions: string[];
  lastIndexedAt?: string;
  lastSource?: SecretWordLastSource;

  // Samba / network parameters
  sambaFilter: string;
  sambaContentFilter: string;
  sambaMaxDays: number;
  autoAddSamba: boolean;
  autoAddLimit: number;

  // Local "Soubory" search parameters
  query: string;
  contentQuery: string;
  folderMaxDays: number;
  searchMode: "and" | "or";
  ocrMaxPages: number;
};

type IndexStatusResponse = {
  tableExists?: boolean;
  hasAnyIndex?: boolean;
  hasContextIndex?: boolean;
  error?: string;
};

const MAX_FILE_BYTES = 200_000;
const MAX_CONTEXT_CHARS = 20_000;
const SEARCH_BATCH_SIZE = 25;
const REQUEST_TIMEOUT_MS = 20_000;
const CHAT_REQUEST_TIMEOUT_MS = 90_000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build"]);
const DEFAULT_OCR_MAX_PAGES = 5;
const OCR_BATCH_SIZE = 5;
const CONTEXTS_STORAGE_KEY = "nai.savedContexts.v1";

const DEFAULT_SECRET_WORD_SETTINGS: SecretWordSettings = {
  sambaPath: "",
  extensions: [],
  lastIndexedAt: undefined,
  lastSource: undefined,
  sambaFilter: "",
  sambaContentFilter: "",
  sambaMaxDays: 0,
  autoAddSamba: false,
  autoAddLimit: 0,
  query: "",
  contentQuery: "",
  folderMaxDays: 0,
  searchMode: "and",
  ocrMaxPages: DEFAULT_OCR_MAX_PAGES,
};

type CachedTextRecord = {
  path: string;
  text: string;
  size: number;
  modified?: string;
  created?: string;
  storedAt: number;
};

const TEXT_CACHE_DB = "nai.textCache.v1";
const TEXT_CACHE_STORE = "texts";

function openTextCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB is not available"));
      return;
    }
    const req = indexedDB.open(TEXT_CACHE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TEXT_CACHE_STORE)) {
        db.createObjectStore(TEXT_CACHE_STORE, { keyPath: "path" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open cache"));
  });
}

async function cachePutText(record: CachedTextRecord): Promise<void> {
  const db = await openTextCacheDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(TEXT_CACHE_STORE, "readwrite");
    const store = tx.objectStore(TEXT_CACHE_STORE);
    store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Cache put failed"));
    tx.onabort = () => reject(tx.error ?? new Error("Cache put aborted"));
  });
}

async function cacheGetText(path: string): Promise<CachedTextRecord | null> {
  const db = await openTextCacheDb();
  return await new Promise<CachedTextRecord | null>((resolve, reject) => {
    const tx = db.transaction(TEXT_CACHE_STORE, "readonly");
    const store = tx.objectStore(TEXT_CACHE_STORE);
    const req = store.get(path);
    req.onsuccess = () => resolve((req.result as CachedTextRecord) ?? null);
    req.onerror = () => reject(req.error ?? new Error("Cache get failed"));
  });
}

function generateUUID(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
    return (
      hex.slice(0, 4).join("") +
      "-" +
      hex.slice(4, 6).join("") +
      "-" +
      hex.slice(6, 8).join("") +
      "-" +
      hex.slice(8, 10).join("") +
      "-" +
      hex.slice(10, 16).join("")
    );
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Remove diacritics and normalize for fuzzy Czech matching.
 * "Příloha" → "priloha", "č.j." → "c.j."
 */
function normalizeCzech(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Parse comma-separated search terms.
 * Prefix ! means exclude.  Returns { include, exclude } arrays (normalized).
 * Example: "docx, smlouva, !eon" →
 *   include: ["docx", "smlouva"], exclude: ["eon"]
 */
function parseSearchTerms(input: string): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of input.split(",")) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith("!")) {
      const val = normalizeCzech(t.slice(1).trim());
      if (val) exclude.push(val);
    } else {
      include.push(normalizeCzech(t));
    }
  }
  return { include, exclude };
}

/**
 * Check if `text` fuzzy-contains `term` (both should be pre-normalized).
 * Also tries with/without dot prefix for extensions.
 */
function fuzzyContains(text: string, term: string): boolean {
  if (text.includes(term)) return true;
  if (text.includes(`.${term}`)) return true;
  return false;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

function extractCountNeedle(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  // Prefer quoted text: "orderid"
  const quoted = trimmed.match(/["'`´“”]([^"'`´“”]+)["'`´“”]/);
  if (quoted?.[1]) return quoted[1].trim();

  // Otherwise take the last token
  const STOPWORDS = new Set([
    // Czech / English filler words that frequently appear at the end
    "kolik",
    "soubor",
    "souborech",
    "souboru",
    "ve",
    "v",
    "vsech",
    "všech",
    "jich",
    "je",
    "jsou",
    "celkem",
    "kolikrat",
    "kolikrát",
    "vyskytu",
    "výskytů",
    "vyskyt",
    "výskyt",
    "prvni",
    "první",
    "sloupec",
    "sloupci",
    "column",
    "first",
    "the",
    "a",
    "an",
    "to",
    "of",
    "and",
    "or",
    "in",
    "on",
    "for",
    "with",
  ]);

  const tokens = trimmed.match(/[a-z0-9_]{2,}/gi) ?? [];
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i].trim();
    if (!token) continue;
    if (STOPWORDS.has(token.toLowerCase())) continue;
    return token;
  }

  // Fallback: last token cleanup
  const lastToken = trimmed.split(/\s+/).pop();
  if (!lastToken) return null;
  const cleaned = lastToken.replace(/^[^a-z0-9_]+|[^a-z0-9_]+$/gi, "");
  return cleaned || null;
}

function countLinesFast(text: string): number {
  const normalized = text.replace(/\r\n?/g, "\n");
  // Trim only trailing whitespace/newlines so we don't count a final empty line.
  const trimmedEnd = normalized.replace(/[\s\n]+$/g, "");
  if (!trimmedEnd) return 0;
  let count = 1;
  for (let i = 0; i < trimmedEnd.length; i += 1) {
    if (trimmedEnd[i] === "\n") count += 1;
  }
  return count;
}

function detectCsvDelimiter(headerLine: string): "," | ";" | "\t" {
  const comma = (headerLine.match(/,/g) ?? []).length;
  const semicolon = (headerLine.match(/;/g) ?? []).length;
  const tab = (headerLine.match(/\t/g) ?? []).length;
  if (semicolon >= comma && semicolon >= tab) return ";";
  if (tab >= comma && tab >= semicolon) return "\t";
  return ",";
}

function looksLikeDelimitedText(text: string): boolean {
  // Rough heuristic: enough newlines and a common delimiter.
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

  // ISO-ish: 2025-12-31 or 2025-12
  const iso = v.match(/\b(\d{4})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}`;

  // Czech: 31.12.2025 or 31. 12. 2025
  const cz = v.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (cz) {
    const month = String(Math.max(1, Math.min(12, Number(cz[2]) || 0))).padStart(2, "0");
    return `${cz[3]}-${month}`;
  }

  // Slash: 12/31/2025 or 31/12/2025 (we assume if first > 12 then it's DD/MM)
  const slash = v.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const year = slash[3];
    const monthNum = a > 12 ? b : a;
    const month = String(Math.max(1, Math.min(12, monthNum || 0))).padStart(2, "0");
    return `${year}-${month}`;
  }

  // Fallback to Date.parse (handles many formats including RFC/ISO with time)
  const t = Date.parse(v);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    if (year >= 1970 && year <= 2100) return `${year}-${month}`;
  }

  return null;
}

type OrdersByMonthResult = {
  byMonth: Array<{ ym: string; count: number }>;
  filesUsed: number;
  rowsUsed: number;
  rowsSkipped: number;
  usedUniqueOrderIds: boolean;
  notes: string[];
};

type OrdersByStateResult = {
  byState: Array<{ state: string; count: number }>;
  filesUsed: number;
  rowsUsed: number;
  rowsSkipped: number;
  usedUniqueOrderIds: boolean;
  notes: string[];
};

async function computeOrdersByYearMonth(
  fileContext: FileContext[],
  signal?: AbortSignal
): Promise<OrdersByMonthResult> {
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
  const MAX_UNIQUE_PER_MONTH = 200_000;
  let usedUniqueOrderIds = true;
  let filesUsed = 0;
  let rowsUsed = 0;
  let rowsSkipped = 0;

  for (let fi = 0; fi < fileContext.length; fi += 1) {
    if (signal?.aborted) {
      notes.push("Výpočet byl zrušen (abort).");
      break;
    }
    const f = fileContext[fi];
    const isLikelyCsv = /\.(csv|tsv)(\s|$)/i.test(f.path) || looksLikeDelimitedText(f.content);
    if (!isLikelyCsv) continue;

    const lines = f.content
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    if (lines.length < 2) continue;

    const delimiter = detectCsvDelimiter(lines[0]);
    const headerFields = parseCsvLine(lines[0], delimiter).map((x) => x.trim());
    if (headerFields.length < 2) continue;

    const orderIdx = findHeaderIndex(headerFields, orderIdCandidates);
    const dateIdx = findHeaderIndex(headerFields, dateCandidates);
    if (dateIdx < 0) continue;

    filesUsed += 1;

    for (let li = 1; li < lines.length; li += 1) {
      const row = parseCsvLine(lines[li], delimiter);
      const dateVal = (row[dateIdx] ?? "").trim();
      const ym = parseYearMonth(dateVal);
      if (!ym) {
        rowsSkipped += 1;
        continue;
      }

      if (orderIdx >= 0 && usedUniqueOrderIds) {
        const orderId = (row[orderIdx] ?? "").trim();
        if (!orderId) {
          rowsSkipped += 1;
          continue;
        }
        let s = setsByMonth.get(ym);
        if (!s) {
          s = new Set<string>();
          setsByMonth.set(ym, s);
        }
        s.add(orderId);
        // Safety valve for very large datasets
        if (s.size > MAX_UNIQUE_PER_MONTH) {
          usedUniqueOrderIds = false;
          notes.push(
            `Měsíc ${ym} překročil ${MAX_UNIQUE_PER_MONTH} unikátních orderId; přepínám na počítání řádků (bez deduplikace).`
          );
          setsByMonth.clear();
        }
      } else {
        countByMonth.set(ym, (countByMonth.get(ym) ?? 0) + 1);
      }
      rowsUsed += 1;
    }

    if (fi % 25 === 0) {
      // Yield to keep UI responsive
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
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
      "Nenašel jsem v kontextu CSV/TSV se sloupcem pro datum. Zkontrolujte, že CSV obsahují hlavičku a sloupec datum/order_date."
    );
  } else if (byMonth.length === 0) {
    notes.push(
      "Našel jsem sice soubory, ale nepodařilo se z nich vyparsovat žádné platné datum (rok-měsíc)."
    );
  }

  return {
    byMonth,
    filesUsed,
    rowsUsed,
    rowsSkipped,
    usedUniqueOrderIds,
    notes,
  };
}

async function computeOrdersByState(
  fileContext: FileContext[],
  signal?: AbortSignal
): Promise<OrdersByStateResult> {
  const orderIdCandidates = [
    "orderid",
    "order_id",
    "ordernumber",
    "order_number",
    "objednavkaid",
    "objednavka_id",
    "idobjednavky",
  ];
  const stateCandidates = [
    "country",
    "state",
    "stat",
    "zeme",
    "země",
    "land",
    "shipping_country",
    "billing_country",
  ];

  const notes: string[] = [];
  const countByState = new Map<string, number>();
  const setsByState = new Map<string, Set<string>>();
  const MAX_UNIQUE_PER_STATE = 200_000;
  let usedUniqueOrderIds = true;
  let filesUsed = 0;
  let rowsUsed = 0;
  let rowsSkipped = 0;

  for (let fi = 0; fi < fileContext.length; fi += 1) {
    if (signal?.aborted) {
      notes.push("Výpočet byl zrušen (abort).");
      break;
    }
    const f = fileContext[fi];
    const isLikelyCsv = /\.(csv|tsv)(\s|$)/i.test(f.path) || looksLikeDelimitedText(f.content);
    if (!isLikelyCsv) continue;

    const lines = f.content
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    if (lines.length < 2) continue;

    const delimiter = detectCsvDelimiter(lines[0]);
    const headerFields = parseCsvLine(lines[0], delimiter).map((x) => x.trim());
    if (headerFields.length < 2) continue;

    const orderIdx = findHeaderIndex(headerFields, orderIdCandidates);
    const stateIdx = findHeaderIndex(headerFields, stateCandidates);
    if (stateIdx < 0) continue;

    filesUsed += 1;

    for (let li = 1; li < lines.length; li += 1) {
      const row = parseCsvLine(lines[li], delimiter);
      const stateVal = (row[stateIdx] ?? "").trim();
      if (!stateVal) {
        rowsSkipped += 1;
        continue;
      }

      if (orderIdx >= 0 && usedUniqueOrderIds) {
        const orderId = (row[orderIdx] ?? "").trim();
        if (!orderId) {
          rowsSkipped += 1;
          continue;
        }
        let s = setsByState.get(stateVal);
        if (!s) {
          s = new Set<string>();
          setsByState.set(stateVal, s);
        }
        s.add(orderId);
        // Safety valve for very large datasets
        if (s.size > MAX_UNIQUE_PER_STATE) {
          usedUniqueOrderIds = false;
          notes.push(
            `Stát ${stateVal} překročil ${MAX_UNIQUE_PER_STATE} unikátních orderId; přepínám na počítání řádků (bez deduplikace).`
          );
          setsByState.clear();
        }
      } else {
        countByState.set(stateVal, (countByState.get(stateVal) ?? 0) + 1);
      }
      rowsUsed += 1;
    }

    if (fi % 25 === 0) {
      // Yield to keep UI responsive
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  if (usedUniqueOrderIds) {
    for (const [state, set] of setsByState.entries()) {
      countByState.set(state, set.size);
    }
  }

  const byState = Array.from(countByState.entries())
    .map(([state, count]) => ({ state, count }))
    .sort((a, b) => b.count - a.count); // Sort by count descending

  if (filesUsed === 0) {
    notes.push(
      "Nenašel jsem v kontextu CSV/TSV se sloupcem pro stát/zemi. Zkontrolujte, že CSV obsahují hlavičku a sloupec country/state/stat."
    );
  } else if (byState.length === 0) {
    notes.push(
      "Našel jsem sice soubory, ale nepodařilo se z nich vyparsovat žádné platné hodnoty státu/země."
    );
  }

  return {
    byState,
    filesUsed,
    rowsUsed,
    rowsSkipped,
    usedUniqueOrderIds,
    notes,
  };
}

function countCsvColumnValues(text: string, columnName: string | null): number {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) return 0;

  const header = lines[0];
  const delimiter = detectCsvDelimiter(header);
  const headerFields = parseCsvLine(header, delimiter).map((f) => f.trim());

  let columnIndex = 0;
  if (columnName) {
    const normalized = columnName.trim().toLowerCase();
    const idx = headerFields.findIndex((f) => f.toLowerCase() === normalized);
    if (idx >= 0) columnIndex = idx;
  }

  let count = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const row = parseCsvLine(lines[i], delimiter);
    const value = (row[columnIndex] ?? "").trim();
    if (value.length > 0) count += 1;
  }
  return count;
}

async function collectFiles(
  dirHandle: FileSystemDirectoryHandle,
  prefix = ""
): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "directory") {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) {
        continue;
      }
      const nested = await collectFiles(
        handle as FileSystemDirectoryHandle,
        `${prefix}${name}/`
      );
      entries.push(...nested);
    }
    if (handle.kind === "file") {
      const file = await (handle as FileSystemFileHandle).getFile();
      entries.push({
        path: `${prefix}${name}`,
        handle: handle as FileSystemFileHandle,
        size: file.size,
        modified: new Date(file.lastModified).toISOString(),
      });
    }
  }
  return entries;
}

function getFileExtensionFromPath(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) {
    return "";
  }
  return name.slice(dotIndex + 1).toLowerCase();
}

async function readXlsxText(file: File, maxChars: number): Promise<string> {
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, {
    type: "array",
    cellText: false,
    cellDates: true,
  });

  const textParts: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    textParts.push(`Sheet: ${sheetName}\n`);
    const csvContent = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (csvContent.trim().length > 0) {
      textParts.push(csvContent);
    }
    if (textParts.join("\n").length >= maxChars) {
      break;
    }
  }

  const output = textParts.join("\n").trim();
  if (output.length > maxChars) {
    return `${output.slice(0, maxChars)}\n\n[Truncated to ${maxChars} chars]`;
  }
  return output;
}

async function readDocxText(file: File, maxChars: number): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const buffer = await file.arrayBuffer();
  const zip = new JSZip();
  await zip.loadAsync(buffer);
  const xmlFile = zip.file("word/document.xml");
  if (!xmlFile) {
    throw new Error("Invalid DOCX file");
  }
  const xmlContent = await xmlFile.async("text");
  const text = xmlContent
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();

  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}\n\n[Truncated to ${maxChars} chars]`;
  }
  return text;
}

async function readFileText(
  entry: FileEntry,
  maxBytes = MAX_FILE_BYTES,
  ocrMaxPages = DEFAULT_OCR_MAX_PAGES,
  onProgress?: (percent: number, label: string) => void
): Promise<string> {
  const file = entry.handle
    ? await entry.handle.getFile()
    : entry.file;
  if (!file) {
    throw new Error("Missing file handle");
  }
  const ext = getFileExtensionFromPath(entry.path);
  const isPdf =
    file.type === "application/pdf" ||
    entry.path.toLowerCase().endsWith(".pdf");
  if (isPdf) {
    const text = await readPdfText(
      file,
      maxBytes,
      ocrMaxPages,
      onProgress
    );
    return text;
  }
  if (ext === "xlsx" || ext === "xls") {
    return await readXlsxText(file, maxBytes);
  }
  if (ext === "docx") {
    return await readDocxText(file, maxBytes);
  }
  const blob = file.size > maxBytes ? file.slice(0, maxBytes) : file;
  const text = await blob.text();
  if (file.size > maxBytes) {
    return `${text}\n\n[Truncated to ${maxBytes} bytes]`;
  }
  return text;
}

async function readPdfText(
  file: File,
  maxChars = MAX_FILE_BYTES,
  ocrMaxPages = DEFAULT_OCR_MAX_PAGES,
  onProgress?: (percent: number, label: string) => void
) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    import.meta.url
  ).toString();
  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  let output = "";

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = (content.items as Array<{ str?: string }>)
      .map((item) => item.str ?? "")
      .join(" ");
    output += `${pageText}\n`;
    onProgress?.(
      Math.min(99, Math.round((pageNumber / doc.numPages) * 100)),
      `PDF text ${pageNumber}/${doc.numPages}`
    );
    if (output.length >= maxChars) {
      output = `${output.slice(0, maxChars)}\n\n[Truncated to ${maxChars} chars]`;
      break;
    }
  }

  const cleaned = output.trim();
  if (cleaned) {
    return cleaned;
  }

  const ocrText = await ocrPdfText(doc, maxChars, ocrMaxPages, onProgress);
  if (!ocrText) {
    throw new Error("PDF nemá čitelný text (možná sken)." );
  }
  return ocrText;
}

async function ocrPdfText(
  doc: { numPages: number; getPage: (n: number) => Promise<unknown> },
  maxChars: number,
  ocrMaxPages: number,
  onProgress?: (percent: number, label: string) => void
) {
  if (typeof document === "undefined") {
    return "";
  }
  const { recognize } = await import("tesseract.js");
  let output = "";
  const maxPages = Math.min(doc.numPages, Math.max(1, ocrMaxPages));

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const page = (await doc.getPage(pageNumber)) as {
      getViewport: (o: { scale: number }) => { width: number; height: number };
      render: (o: {
        canvasContext: CanvasRenderingContext2D;
        viewport: { width: number; height: number };
      }) => { promise: Promise<unknown> };
    };

    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) {
      continue;
    }
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: context, viewport }).promise;

    const { data } = await recognize(canvas, "eng+ces", {
      logger: () => {},
    });
    output += `${data.text}\n`;
    onProgress?.(
      Math.min(99, Math.round((pageNumber / maxPages) * 100)),
      `OCR ${pageNumber}/${maxPages}`
    );
    if (output.length >= maxChars) {
      output = `${output.slice(0, maxChars)}\n\n[Truncated to ${maxChars} chars]`;
      break;
    }
    if (pageNumber % OCR_BATCH_SIZE === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return output.trim();
}

function buildContext(files: FileContext[]): string {
  const TRUNC_MARKER = "\n\n[Context truncated]";
  const effectiveLimit = Math.max(0, MAX_CONTEXT_CHARS - TRUNC_MARKER.length);

  let output = "";
  const totalSize = files.reduce((sum, file) => sum + (file.size || 0), 0);
  const summaryLines: string[] = [
    "# Context summary",
    `total_files=${files.length}`,
    `total_size_bytes=${totalSize}`,
    "files:",
  ];

  let listCount = 0;
  const listLimit = 200;
  for (const file of files) {
    if (listCount >= listLimit) {
      summaryLines.push(`... ${files.length - listLimit} more`);
      break;
    }
    const meta: string[] = [`size_bytes=${file.size}`];
    if (file.modified) meta.push(`modified=${file.modified}`);
    if (file.created) meta.push(`created=${file.created}`);
    summaryLines.push(`- ${file.path} (${meta.join(", ")})`);
    listCount += 1;
  }

  const summaryString = summaryLines.join("\n");
  output = summaryString.slice(0, effectiveLimit);

  let truncated = output.length < summaryString.length;
  for (const file of files) {
    if (truncated) break;

    const meta: string[] = [];
    meta.push(`size_bytes=${file.size}`);
    if (file.modified) meta.push(`modified=${file.modified}`);
    if (file.created) meta.push(`created=${file.created}`);
    const header = meta.length > 0 ? `${file.path} (${meta.join(", ")})` : file.path;
    const section = `# ${header}\n${file.content}`;

    const sep = output ? "\n\n" : "";
    const addition = `${sep}${section}`;

    if (output.length + addition.length <= effectiveLimit) {
      output += addition;
      continue;
    }

    const remaining = effectiveLimit - output.length;
    if (remaining > 0) {
      output += addition.slice(0, remaining);
    }
    truncated = true;
  }

  if (truncated) {
    // Ensure we never exceed MAX_CONTEXT_CHARS.
    return `${output}${TRUNC_MARKER}`.slice(0, MAX_CONTEXT_CHARS);
  }
  return output;
}

function getExtension(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) {
    return "bez přípony";
  }
  return name.slice(dotIndex + 1).toLowerCase();
}

function extractChartBlock(text: string): {
  cleanText: string;
  chart: AssistantChart | AssistantChart3D | null;
} {
  const blockRegex = /\[\[CHART\]\]([\s\S]*?)\[\[\/CHART\]\]/i;
  const match = text.match(blockRegex);
  if (!match) {
    return { cleanText: text, chart: null };
  }

  const raw = match[1].trim();
  let chart: AssistantChart | AssistantChart3D | null = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.type === "3d" && Array.isArray(parsed.data)) {
      chart = parsed as AssistantChart3D;
    } else if (
      parsed &&
      (parsed.type === "pie" || parsed.type === "bar" || parsed.type === "line") &&
      Array.isArray(parsed.labels) &&
      Array.isArray(parsed.series)
    ) {
      chart = parsed as AssistantChart;
    }
  } catch {
    chart = null;
  }

  const cleanText = text.replace(blockRegex, "").trim();
  return { cleanText, chart };
}

function extractTableBlock(text: string): {
  cleanText: string;
  table: AssistantTable | null;
} {
  const blockRegex = /\[\[TABLE\]\]([\s\S]*?)\[\[\/TABLE\]\]/i;
  const match = text.match(blockRegex);
  if (!match) {
    return { cleanText: text, table: null };
  }

  const raw = match[1].trim();
  let table: AssistantTable | null = null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      parsed.title &&
      Array.isArray(parsed.headers) &&
      Array.isArray(parsed.rows)
    ) {
      table = parsed as AssistantTable;
    }
  } catch {
    table = null;
  }

  const cleanText = text.replace(blockRegex, "").trim();
  return { cleanText, table };
}

function extractStructuredBlock(text: string): {
  cleanText: string;
  structured: StructuredResult | null;
} {
  const blockRegex = /\[\[STRUCTURED\]\]([\s\S]*?)\[\[\/STRUCTURED\]\]/i;
  const match = text.match(blockRegex);
  if (!match) {
    return { cleanText: text, structured: null };
  }

  const raw = match[1].trim();
  let structured: StructuredResult | null = null;
  try {
    const parsed = JSON.parse(raw) as StructuredResult;
    if (parsed && Array.isArray(parsed.groups)) {
      structured = parsed;
    }
  } catch {
    structured = null;
  }

  const cleanText = text.replace(blockRegex, "").trim();
  return { cleanText, structured };
}

export default function Home() {
  const [directoryName, setDirectoryName] = useState<string | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [query, setQuery] = useState("");
  const [contentQuery, setContentQuery] = useState("");
  const [results, setResults] = useState<FileEntry[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [selectedLocalFilePaths, setSelectedLocalFilePaths] = useState<Set<string>>(new Set());
  const [selectLocalFilesAllChecked, setSelectLocalFilesAllChecked] = useState(false);
  const [fileContext, setFileContext] = useState<FileContext[]>([]);
  const [searchContent, setSearchContent] = useState(false);
  const [searchMode, setSearchMode] = useState<"and" | "or">("and"); // AND by default
  const [status, setStatus] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isAddingToContext, setIsAddingToContext] = useState(false);
  const [addContextMode, setAddContextMode] = useState<"results" | "local" | "samba" | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatHistory, setChatHistory] = useState<ChatHistoryItem[]>([]);
  const [structuredResult, setStructuredResult] = useState<StructuredResult | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("chat");
  const [lastSearchSources, setLastSearchSources] = useState<Array<{ path: string; lineCount?: number; fileSize?: number }>>([]);
  const [isSending, setIsSending] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [isIndexed, setIsIndexed] = useState(false);
  const [selectAllChecked, setSelectAllChecked] = useState(false);
  const [sambaPath, setSambaPath] = useState<string>("");
  const [sambaFiles, setSambaFiles] = useState<SambaEntry[]>([]);
  const [isSambaScanning, setIsSambaScanning] = useState(false);
  const [sambaStats, setSambaStats] = useState<SambaStats | null>(null);
  const [sambaSuggestedPaths, setSambaSuggestedPaths] = useState<Array<{ path: string; name: string }>>([]);
  const [autoAddSamba, setAutoAddSamba] = useState(false);
  const [autoAddLimit, setAutoAddLimit] = useState(0);
  const [sambaFilter, setSambaFilter] = useState("");
  const [sambaContentFilter, setSambaContentFilter] = useState("");
  const [isSambaFiltering, setIsSambaFiltering] = useState(false);
  const [sambaMaxDays, setSambaMaxDays] = useState(0);
  const [folderMaxDays, setFolderMaxDays] = useState(0);
  const [lastScannedSambaPath, setLastScannedSambaPath] = useState("");
  const searchAbortRef = useRef<AbortController | null>(null);
  const sambaCancelRef = useRef<AbortController | null>(null);
  const addFilesAbortRef = useRef<AbortController | null>(null);
  const indexAbortRef = useRef<AbortController | null>(null);
  const directoryInputRef = useRef<HTMLInputElement | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const voiceRecogRef = useRef<SpeechRecognitionInstance | null>(null);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const voiceBaseInputRef = useRef("");
  const voiceFinalRef = useRef("");
  const [chartType, setChartType] = useState<ChartType2D>("pie");
  const [chartSource, setChartSource] = useState<ChartSource>("results");
  const [assistantCharts, setAssistantCharts] = useState<AssistantChartItem[]>(
    []
  );
  const [assistantTables, setAssistantTables] = useState<AssistantTableItem[]>(
    []
  );
  const [assistantFilesSortBy, setAssistantFilesSortBy] = useState<AssistantFileSortBy>("path");
  const [assistantFilesSortDesc, setAssistantFilesSortDesc] = useState<boolean>(false);
  const [ocrMaxPages, setOcrMaxPages] = useState<number>(
    DEFAULT_OCR_MAX_PAGES
  );
  const [loadProgress, setLoadProgress] = useState<LoadProgress | null>(null);
  const [savedContexts, setSavedContexts] = useState<SavedContext[]>([]);
  const [activeContextId, setActiveContextId] = useState<string | null>(null);
  const [newContextName, setNewContextName] = useState("");
  const [newContextSambaPath, setNewContextSambaPath] = useState("");
  const [syncProgress, setSyncProgress] = useState<LoadProgress | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [indexProgress, setIndexProgress] = useState<LoadProgress | null>(null);
  const [contextFilter, setContextFilter] = useState<string>("");
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [themeLoaded, setThemeLoaded] = useState(false);
  const [contextSortBy, setContextSortBy] = useState<"name" | "lines" | "size" | "modified">("name");
  const [contextSortDesc, setContextSortDesc] = useState(false);
  const [sambaSortBy, setSambaSortBy] = useState<"name" | "lines" | "size" | "modified">("name");
  const [sambaSortDesc, setSambaSortDesc] = useState(false);
  const [sambaAddFilter, setSambaAddFilter] = useState<string>("");
  const [fileFilter, setFileFilter] = useState<string>("");
  const [fileSortBy, setFileSortBy] = useState<"name" | "lines" | "size">("name");
  const [fileSortDesc, setFileSortDesc] = useState(false);
  const [uiLoadLimit, setUiLoadLimit] = useState<number>(200);
  const [uiLoadCacheOnly, setUiLoadCacheOnly] = useState<boolean>(true);
  const [dbIndexStatus, setDbIndexStatus] = useState<{
    checked: boolean;
    hasAnyIndex: boolean;
    hasContextIndex: boolean;
  }>({ checked: false, hasAnyIndex: false, hasContextIndex: false });
  const [knowledgeBase, setKnowledgeBase] = useState<{
    initialized: boolean;
    totalFiles: number;
    totalChunks: number;
    embeddingDimension: number | null;
    lastIndexedAt: string | null;
    readyForSearch: boolean;
  } | null>(null);
  const [secretWord, setSecretWord] = useState<string>("");
  const [secretWordCheckingStatus, setSecretWordCheckingStatus] = useState<string | null>(null);
  const [showSecretWord, setShowSecretWord] = useState(true);
  const [savedSecretWords, setSavedSecretWords] = useState<string[]>([]);
  const [secretWordSettings, setSecretWordSettings] = useState<SecretWordSettings>(
    DEFAULT_SECRET_WORD_SETTINGS
  );
  const [isDeletingSecretWord, setIsDeletingSecretWord] = useState(false);

  const normalizedSecretWord = secretWord.trim();
  const isSecretUnlocked = normalizedSecretWord.length >= 5;

  const contextsForSecret = useMemo(() => {
    if (!isSecretUnlocked) return [];
    return savedContexts.filter((ctx) => ctx.secretKey === normalizedSecretWord);
  }, [savedContexts, isSecretUnlocked, normalizedSecretWord]);
  const [dataWarning, setDataWarning] = useState<{
    visible: boolean;
    title?: string;
    details?: string;
    filteredFiles?: number;
    totalFiles?: number;
    onConfirm?: () => void;
  }>({ visible: false });
  const [pendingChatRequest, setPendingChatRequest] = useState<{
    message: string;
    contextText: string;
    totalFiles: number;
    filteredFiles: number;
    contextSize: number;
  } | null>(null);
  const [contextDisplayCount, setContextDisplayCount] = useState(500);

  const chatSuggestions = useMemo(() => {
    const ok = chatHistory.filter((x) => x.ok);
    const base = ok.length > 0 ? ok : chatHistory;
    return base.slice(0, 5);
  }, [chatHistory]);

  const chatHistoryStorageKey = (word: string) => `nai.chatHistory.v1.${word}`;

  const loadChatHistoryForWord = (word: string): ChatHistoryItem[] => {
    if (typeof window === "undefined" || word.length < 5) return [];
    try {
      const raw = window.localStorage.getItem(chatHistoryStorageKey(word));
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      const items = parsed
        .map((x) => {
          const obj = x as Partial<ChatHistoryItem>;
          return {
            id: typeof obj.id === "string" ? obj.id : generateUUID(),
            q: typeof obj.q === "string" ? obj.q : "",
            ok: Boolean(obj.ok),
            ts: typeof obj.ts === "number" ? obj.ts : Date.now(),
          } satisfies ChatHistoryItem;
        })
        .filter((x) => x.q.trim().length > 0)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 5);
      return items;
    } catch {
      return [];
    }
  };

  const persistChatHistoryForWord = (word: string, items: ChatHistoryItem[]) => {
    if (typeof window === "undefined" || word.length < 5) return;
    try {
      window.localStorage.setItem(chatHistoryStorageKey(word), JSON.stringify(items));
    } catch {
      // ignore storage errors
    }
  };

  const recordChatQueryStart = (word: string, q: string): string | null => {
    if (typeof window === "undefined" || word.length < 5) return null;
    const query = q.trim();
    if (!query) return null;
    const id = generateUUID();
    setChatHistory((prev) => {
      const next: ChatHistoryItem[] = [
        { id, q: query, ok: false, ts: Date.now() },
        ...prev.filter((x) => x.q !== query),
      ]
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 5);
      persistChatHistoryForWord(word, next);
      return next;
    });
    return id;
  };

  const finalizeChatQuery = (word: string, id: string | null, ok: boolean) => {
    if (typeof window === "undefined" || word.length < 5 || !id) return;
    setChatHistory((prev) => {
      const next = prev
        .map((x) => (x.id === id ? { ...x, ok } : x))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 5);
      persistChatHistoryForWord(word, next);
      return next;
    });
  };

  const loadSecretWordSettings = (word: string): SecretWordSettings => {
    if (typeof window === "undefined" || word.length < 5) {
      return DEFAULT_SECRET_WORD_SETTINGS;
    }
    try {
      const key = `nai.secretWordSettings.${word}`;
      const saved = window.localStorage.getItem(key);
      if (!saved) return DEFAULT_SECRET_WORD_SETTINGS;
      const parsed = JSON.parse(saved) as Partial<SecretWordSettings>;
      return {
        ...DEFAULT_SECRET_WORD_SETTINGS,
        ...parsed,
        extensions: Array.isArray(parsed.extensions)
          ? parsed.extensions
              .map((x) => String(x).trim())
              .filter((x) => x.length > 0)
          : [],
        searchMode: parsed.searchMode === "or" ? "or" : "and",
        ocrMaxPages:
          typeof parsed.ocrMaxPages === "number" && parsed.ocrMaxPages > 0
            ? Math.min(50, Math.max(1, parsed.ocrMaxPages))
            : DEFAULT_OCR_MAX_PAGES,
        sambaMaxDays:
          typeof parsed.sambaMaxDays === "number" && parsed.sambaMaxDays >= 0
            ? parsed.sambaMaxDays
            : 0,
        folderMaxDays:
          typeof parsed.folderMaxDays === "number" && parsed.folderMaxDays >= 0
            ? parsed.folderMaxDays
            : 0,
        autoAddLimit:
          typeof parsed.autoAddLimit === "number" && parsed.autoAddLimit >= 0
            ? parsed.autoAddLimit
            : 0,
        autoAddSamba: Boolean(parsed.autoAddSamba),
        sambaFilter: typeof parsed.sambaFilter === "string" ? parsed.sambaFilter : "",
        sambaContentFilter:
          typeof parsed.sambaContentFilter === "string" ? parsed.sambaContentFilter : "",
        query: typeof parsed.query === "string" ? parsed.query : "",
        contentQuery: typeof parsed.contentQuery === "string" ? parsed.contentQuery : "",
        sambaPath: typeof parsed.sambaPath === "string" ? parsed.sambaPath : "",
      };
    } catch {
      return DEFAULT_SECRET_WORD_SETTINGS;
    }
  };

  const applySecretWordToSambaForm = async (word: string) => {
    const merged = loadSecretWordSettings(word);
    setSecretWord(word);
    setSecretWordSettings(merged);

    const nextPath = merged.sambaPath;
    setSambaPath(nextPath);
    setSambaFilter(merged.sambaFilter);
    setSambaContentFilter(merged.sambaContentFilter);
    setSambaMaxDays(Math.max(0, merged.sambaMaxDays));
    setAutoAddSamba(Boolean(merged.autoAddSamba));
    setAutoAddLimit(Math.max(0, merged.autoAddLimit));

    if (nextPath.trim() !== lastScannedSambaPath) {
      setSambaFiles([]);
      setSambaStats(null);
    }

    // Auto-scan Samba (jen zobrazí soubory, bez indexace/přidání do kontextu)
    if (nextPath.trim()) {
      try {
        setStatus("Skenování Samby...");
        setIsSambaScanning(true);
        
        const response = await fetch("/api/samba", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sambaPath: nextPath.trim(),
            recursive: true,
            maxFiles: 5000,
            nameFilter: merged.sambaFilter.trim(),
            maxDays: merged.sambaMaxDays,
          }),
        });

        const data = (await response.json()) as {
          success?: boolean;
          files?: SambaEntry[];
          stats?: SambaStats;
          error?: string;
        };

        if (!response.ok) {
          throw new Error(data.error ?? "Samba scan failed.");
        }

        const files = data.files ?? [];
        setSambaFiles(files);
        setSambaStats(data.stats ?? null);
        setLastScannedSambaPath(nextPath.trim());
        
        const fileCount = files.filter((f) => f.type === "file").length;
        setStatus(`✓ Načteno ${fileCount} souborů z Samby (klikni "Add All" pro přidání do kontextu).`);
      } catch (error) {
        setStatus(
          error instanceof Error ? error.message : "Failed to scan Samba."
        );
      } finally {
        setIsSambaScanning(false);
      }
    }
  };

  const applySecretWordToFilesForm = (word: string) => {
    const merged = loadSecretWordSettings(word);
    setSecretWord(word);
    setSecretWordSettings(merged);

    setQuery(merged.query);
    setContentQuery(merged.contentQuery);
    setFolderMaxDays(Math.max(0, merged.folderMaxDays));
    setSearchMode(merged.searchMode);
    setOcrMaxPages(merged.ocrMaxPages);
  };

  const persistSecretWordSettings = (word: string, settings: SecretWordSettings) => {
    if (typeof window === "undefined" || word.length < 5) return;
    try {
      const key = `nai.secretWordSettings.${word}`;
      window.localStorage.setItem(key, JSON.stringify(settings));
    } catch {
      // ignore
    }
  };

  const buildSettingsFromCurrentUi = (
    patch?: Partial<SecretWordSettings>
  ): SecretWordSettings => {
    const inferredSource: SecretWordLastSource | undefined =
      sambaPath.trim().length > 0
        ? "samba"
        : files.length > 0
          ? "files"
          : undefined;

    return {
      ...secretWordSettings,
      ...patch,
      lastSource: patch?.lastSource ?? inferredSource ?? secretWordSettings.lastSource,
      sambaPath: sambaPath.trim(),
      sambaFilter,
      sambaContentFilter,
      sambaMaxDays,
      autoAddSamba,
      autoAddLimit,
      query: query.trimEnd(),
      contentQuery: contentQuery.trimEnd(),
      folderMaxDays,
      searchMode,
      ocrMaxPages,
    };
  };

  const handleSaveSecretWordContext = () => {
    if (!secretWord || secretWord.length < 5) {
      setStatus("Zadejte platné přístupové slovo (min. 5 znaků)." );
      return;
    }
    const next = buildSettingsFromCurrentUi();
    setSecretWordSettings(next);
    persistSecretWordSettings(secretWord, next);
    setStatus(`✓ Uloženo nastavení pro "${secretWord}".`);
  };



  const contextText = useMemo(() => buildContext(fileContext), [fileContext]);

  const filteredContext = useMemo(() => {
    const q = contextFilter.trim().toLowerCase();
    if (!q) return fileContext;
    return fileContext.filter((f) => f.path.toLowerCase().includes(q));
  }, [contextFilter, fileContext]);

  const displayedContext = useMemo(() => {
    let sorted = [...filteredContext];
    
    // Apply sorting
    sorted.sort((a, b) => {
      let comparison = 0;
      
      switch (contextSortBy) {
        case "name":
          const nameA = (a.path.split('/').pop() || a.path).toLowerCase();
          const nameB = (b.path.split('/').pop() || b.path).toLowerCase();
          comparison = nameA.localeCompare(nameB);
          break;
        case "lines":
          comparison = (a.lineCount || 0) - (b.lineCount || 0);
          break;
        case "size":
          comparison = (a.size || 0) - (b.size || 0);
          break;
        case "modified":
          const timeA = a.modified ? new Date(a.modified).getTime() : 0;
          const timeB = b.modified ? new Date(b.modified).getTime() : 0;
          comparison = timeA - timeB;
          break;
      }
      
      return contextSortDesc ? -comparison : comparison;
    });
    
    return sorted.slice(0, contextDisplayCount);
  }, [filteredContext, contextDisplayCount, contextSortBy, contextSortDesc]);

  /** Apply name filter + days filter to samba file list */
  const filterSambaFiles = (allFiles: SambaEntry[]): SambaEntry[] => {
    let result = allFiles;
    // Name filter
    const hasNameFilter = sambaFilter.trim().length > 0;
    if (hasNameFilter) {
      const parsed = parseSearchTerms(sambaFilter);
      const isWild = parsed.include.length === 1 && parsed.include[0] === "*";
      result = result.filter((f) => {
        const text = normalizeCzech(`${String(f.path)} ${String(f.name ?? "")}`);
        if (!isWild && parsed.include.length > 0) {
          if (!parsed.include.every((t) => fuzzyContains(text, t))) return false;
        }
        if (parsed.exclude.length > 0) {
          if (parsed.exclude.some((t) => fuzzyContains(text, t))) return false;
        }
        return true;
      });
    }
    // Days filter
    if (sambaMaxDays > 0) {
      const cutoff = Date.now() - sambaMaxDays * 86_400_000;
      result = result.filter((f) => {
        const ts = f.modified ? new Date(f.modified).getTime() : 0;
        return ts >= cutoff;
      });
    }
    return result;
  };

  const displayedSambaFiles = useMemo(() => {
    const allFiles = sambaFiles.filter((f) => f.type === "file");
    const filesToSort = filterSambaFiles(allFiles);
    
    let sorted = [...filesToSort];
    sorted.sort((a, b) => {
      let comparison = 0;
      
      switch (sambaSortBy) {
        case "name":
          const nameA = (a.name || a.path).toLowerCase();
          const nameB = (b.name || b.path).toLowerCase();
          comparison = nameA.localeCompare(nameB);
          break;
        case "lines":
          // Samba files don't have line counts, treat as equal
          comparison = 0;
          break;
        case "size":
          comparison = (a.size || 0) - (b.size || 0);
          break;
        case "modified":
          const timeA = a.modified ? new Date(a.modified).getTime() : 0;
          const timeB = b.modified ? new Date(b.modified).getTime() : 0;
          comparison = timeA - timeB;
          break;
      }
      
      return sambaSortDesc ? -comparison : comparison;
    });
    
    return sorted.slice(0, 200); // Show first 200
  }, [sambaFiles, sambaFilter, sambaMaxDays, sambaSortBy, sambaSortDesc]);

  // Filter and sort local files
  const displayedFiles = useMemo(() => {
    let filtered = files;
    
    // Filter by filename
    if (fileFilter.trim()) {
      const searchLower = fileFilter.toLowerCase();
      filtered = filtered.filter(f => 
        f.path.toLowerCase().includes(searchLower)
      );
    }
    
    // Sort
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      let comparison = 0;
      
      switch (fileSortBy) {
        case "name":
          const nameA = a.path.toLowerCase();
          const nameB = b.path.toLowerCase();
          comparison = nameA.localeCompare(nameB);
          break;
        case "lines":
          // Local files don't have line counts, treat as equal
          comparison = 0;
          break;
        case "size":
          comparison = (a.size || 0) - (b.size || 0);
          break;
      }
      
      return fileSortDesc ? -comparison : comparison;
    });
    
    return sorted;
  }, [files, fileFilter, fileSortBy, fileSortDesc]);

  // Theme initialization from localStorage (hydration-safe)
  useEffect(() => {
    if (typeof window === 'undefined' || themeLoaded) return;
    const saved = window.localStorage.getItem('nai.theme');
    const loadedTheme = (saved === 'dark' || saved === 'light') ? saved : 'light';
    setTheme(loadedTheme);
    setThemeLoaded(true);
  }, [themeLoaded]);

  // Theme handling
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.className = document.body.className
      .split(' ')
      .filter(c => c !== 'light-theme' && c !== 'dark-theme')
      .concat(`${theme}-theme`)
      .join(' ');
    
    // Save to localStorage
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('nai.theme', theme);
    }
  }, [theme]);

  // Simple voice-to-text initialization
  useEffect(() => {
    if (typeof window === "undefined") return;
    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      setVoiceSupported(false);
      return;
    }

    setVoiceSupported(true);
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = "cs-CZ";
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => {
      setIsRecording(true);
    };

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      let finalText = "";
      let interimText = "";
      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) continue;
        const chunk = result[0]?.transcript ?? "";
        if (!chunk) continue;
        if (result.isFinal) {
          finalText = finalText ? `${finalText} ${chunk}` : chunk;
        } else {
          interimText = interimText ? `${interimText} ${chunk}` : chunk;
        }
      }

      voiceFinalRef.current = finalText.trim();
      const combined = [
        voiceBaseInputRef.current,
        voiceFinalRef.current,
        interimText.trim(),
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (combined) {
        setChatInput(combined);
      }
    };

    recognition.onerror = (event: any) => {
      setIsRecording(false);
      const errorMsg = event?.error ?? "Neznámá chyba";
      const pretty =
        errorMsg === "not-allowed"
          ? "Povolte mikrofon v prohlížeči."
          : errorMsg === "no-speech"
            ? "Neslyším žádný hlas."
            : `Chyba hlasu: ${errorMsg}`;
      setStatus(pretty);
    };

    recognition.onend = () => {
      setIsRecording(false);
      const combined = [voiceBaseInputRef.current, voiceFinalRef.current]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (combined) {
        setChatInput(combined);
      }
    };

    voiceRecogRef.current = recognition;
    return () => {
      try { recognition.stop(); } catch { /* ignore */ }
      voiceRecogRef.current = null;
    };
  }, []);

  const startVoiceInput = () => {
    if (typeof window === "undefined") return;
    if (!voiceSupported || !voiceRecogRef.current) {
      setStatus("Rozpoznání hlasu není v tomto prohlížeči dostupné.");
      return;
    }
    if (!window.isSecureContext) {
      setStatus("Hlasové diktování vyžaduje HTTPS nebo localhost.");
      return;
    }
    voiceBaseInputRef.current = chatInput.trim();
    voiceFinalRef.current = "";
    try {
      voiceRecogRef.current.start();
    } catch (e) {
      setIsRecording(false);
      setStatus(`Chyba: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const stopVoiceInput = () => {
    if (!voiceRecogRef.current) return;
    try {
      voiceRecogRef.current.stop();
    } catch { /* ignore */ }
    setIsRecording(false);
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(CONTEXTS_STORAGE_KEY);
      if (!raw) return;
      let parsed = JSON.parse(raw) as SavedContext[];
      if (Array.isArray(parsed)) {
        // Migrace: přidej secretKey starým kontextům
        parsed = parsed.map((ctx) =>
          ctx.secretKey
            ? ctx
            : {
                ...ctx,
                secretKey: Math.random().toString(36).substring(2, 10).toUpperCase(),
              }
        );
        setSavedContexts(parsed);
      }
    } catch {
      // ignore
    }
  }, []);







  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        CONTEXTS_STORAGE_KEY,
        JSON.stringify(savedContexts)
      );
    } catch (error) {
      console.warn(
        "Failed to persist saved contexts to localStorage:",
        error instanceof Error ? error.message : error
      );
      // Don't spam status if user is actively doing something.
      setStatus(
        "Pozor: nepodařilo se uložit uložené kontexty do prohlížeče (quota/storage). " +
          "Po reloadu se může znovu extrahovat obsah. Zvažte méně souborů nebo méně kontextů."
      );
    }
  }, [savedContexts]);

  useEffect(() => {
    if (!isSecretUnlocked) {
      setActiveContextId(null);
      return;
    }
    if (contextsForSecret.length === 0) {
      setActiveContextId(null);
      return;
    }
    setActiveContextId((prev) =>
      prev && contextsForSecret.some((ctx) => ctx.id === prev)
        ? prev
        : contextsForSecret[0].id
    );
  }, [isSecretUnlocked, contextsForSecret]);

  const activeContext = useMemo(() => {
    if (!isSecretUnlocked || !activeContextId) return null;
    return (
      savedContexts.find(
        (ctx) => ctx.id === activeContextId && ctx.secretKey === normalizedSecretWord
      ) ?? null
    );
  }, [activeContextId, isSecretUnlocked, normalizedSecretWord, savedContexts]);

  const hasDbIndex = useMemo(() => {
    if (!isSecretUnlocked) return false;
    return (
      isIndexed ||
      Boolean(activeContext?.lastIndexedAt) ||
      dbIndexStatus.hasAnyIndex ||
      dbIndexStatus.hasContextIndex ||
      Boolean(knowledgeBase?.initialized)
    );
  }, [
    isSecretUnlocked,
    isIndexed,
    activeContext?.lastIndexedAt,
    dbIndexStatus.hasAnyIndex,
    dbIndexStatus.hasContextIndex,
    knowledgeBase?.initialized,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isSecretUnlocked) {
      setDbIndexStatus({ checked: true, hasAnyIndex: false, hasContextIndex: false });
      return;
    }
    let cancelled = false;

    const run = async () => {
      try {
        const contextId = activeContext?.id ? encodeURIComponent(activeContext.id) : "";
        const url = contextId ? `/api/index/status?contextId=${contextId}` : "/api/index/status";
        const res = await fetch(url);
        const data = (await res.json()) as IndexStatusResponse;
        if (cancelled) return;
        if (!res.ok) {
          setDbIndexStatus({ checked: true, hasAnyIndex: false, hasContextIndex: false });
          return;
        }
        setDbIndexStatus({
          checked: true,
          hasAnyIndex: Boolean(data.hasAnyIndex),
          hasContextIndex: Boolean(data.hasContextIndex),
        });
      } catch {
        if (cancelled) return;
        setDbIndexStatus({ checked: true, hasAnyIndex: false, hasContextIndex: false });
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [activeContext?.id, isSecretUnlocked]);

  // Auto-load Samba file list when switching to a saved context with existing index
  const autoLoadedContextRef = useRef<string | null>(null);
  
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isSecretUnlocked) return;
    if (!activeContext?.sambaPath) return;
    if (!dbIndexStatus.checked) return;
    
    const contextKey = `${activeContext.id}::${activeContext.sambaPath}`;
    
    // Skip if already auto-loaded for this context
    if (autoLoadedContextRef.current === contextKey) return;
    
    const hasIndex = dbIndexStatus.hasContextIndex || dbIndexStatus.hasAnyIndex || Boolean(knowledgeBase?.initialized);
    
    if (!hasIndex) return;
    
    // Mark as loaded to prevent re-triggering
    autoLoadedContextRef.current = contextKey;
    
    const currentSambaPath = activeContext.sambaPath.trim();
    
    // Set the samba path in the input
    setSambaPath(currentSambaPath);
    
    let cancelled = false;
    
    const autoLoadSamba = async () => {
      setIsSambaScanning(true);
      setStatus("Načítám seznam souborů z úložiště...");
      
      try {
        const controller = new AbortController();
        sambaCancelRef.current = controller;
        const timeoutId = setTimeout(
          () => controller.abort(),
          REQUEST_TIMEOUT_MS * 3
        );
        const response = await fetch("/api/samba", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sambaPath: currentSambaPath,
            recursive: true,
            maxFiles: 5000,
            nameFilter: sambaFilter.trim(),
            maxDays: sambaMaxDays,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        
        if (cancelled) return;
        
        const data = (await response.json()) as {
          success?: boolean;
          files?: SambaEntry[];
          stats?: SambaStats;
          error?: string;
        };
        
        if (!response.ok) {
          throw new Error(data.error ?? "Samba scan failed.");
        }
        
        const files = data.files ?? [];
        setSambaFiles(files);
        setSambaStats(data.stats ?? null);
        setLastScannedSambaPath(currentSambaPath);
        setStatus(
          `✓ Úložiště načteno: ${data.stats?.totalFiles} souborů (${data.stats?.totalSizeGB} GB). DB index je připraven — můžete se rovnou ptát v chatu.`
        );
      } catch (error) {
        if (cancelled) return;
        autoLoadedContextRef.current = null; // Reset, aby se dalo retry
        setStatus(
          error instanceof Error ? error.message : "Chyba načítání úložiště."
        );
      } finally {
        if (!cancelled) {
          sambaCancelRef.current = null;
          setIsSambaScanning(false);
        }
      }
    };
    
    autoLoadSamba();
    return () => {
      cancelled = true;
    };
    // Only react to context ID change (not status flags which change too often)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeContext?.id, isSecretUnlocked]);

  useEffect(() => {
    if (isSecretUnlocked) return;
    autoLoadedContextRef.current = null;
    setSambaPath("");
    setSambaFiles([]);
    setSambaStats(null);
    setSambaSuggestedPaths([]);
    setKnowledgeBase(null);
    setDbIndexStatus({ checked: true, hasAnyIndex: false, hasContextIndex: false });
    setIsIndexed(false);
  }, [isSecretUnlocked]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isSecretUnlocked) {
      setKnowledgeBase(null);
      return;
    }
    
    let cancelled = false;

    const loadKB = async () => {
      try {
        const prefix = `${normalizedSecretWord}:`;
        const res = await fetch(`/api/knowledge-base/status?prefix=${encodeURIComponent(prefix)}`);
        const data = (await res.json()) as {
          initialized: boolean;
          totalFiles?: number;
          totalChunks?: number;
          embeddingDimension?: number | null;
          lastIndexedAt?: string | null;
          readyForSearch?: boolean;
        };
        if (cancelled) return;
        setKnowledgeBase({
          initialized: data.initialized ?? false,
          totalFiles: data.totalFiles ?? 0,
          totalChunks: data.totalChunks ?? 0,
          embeddingDimension: data.embeddingDimension ?? null,
          lastIndexedAt: data.lastIndexedAt ?? null,
          readyForSearch: data.readyForSearch ?? false,
        });
      } catch (error) {
        if (cancelled) return;
        console.warn("Failed to load knowledge base status:", error);
      }
    };

    loadKB();
    return () => {
      cancelled = true;
    };
  }, [isSecretUnlocked, normalizedSecretWord]);

  const chartData = useMemo(() => {
    const sourcePaths: string[] = [];
    if (chartSource === "results") {
      sourcePaths.push(...results.map((entry) => entry.path));
    } else {
      sourcePaths.push(
        ...sambaFiles
          .filter((file) => file.type === "file")
          .map((file) => String(file.path ?? file.name ?? ""))
      );
    }

    const counts = new Map<string, number>();
    for (const path of sourcePaths) {
      if (!path) continue;
      const ext = getExtension(path);
      counts.set(ext, (counts.get(ext) ?? 0) + 1);
    }

    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    const maxItems = 12;
    const top = sorted.slice(0, maxItems);
    const rest = sorted.slice(maxItems);
    if (rest.length > 0) {
      const restCount = rest.reduce((sum, [, count]) => sum + count, 0);
      top.push(["ostatní", restCount]);
    }

    return {
      labels: top.map(([label]) => label),
      series: top.map(([, value]) => value),
    };
  }, [chartSource, results, sambaFiles]);

  const handlePickDirectory = async () => {
    if (typeof window !== "undefined" && "showDirectoryPicker" in window) {
      setStatus("Scanning files...");
      try {
        // @ts-expect-error - File System Access API
        const handle = await window.showDirectoryPicker();
        const entries = await collectFiles(handle);
        setFiles(entries);
        setResults([]);
        setSelectedPaths(new Set());
        setDirectoryName(handle.name ?? "Selected folder");
        setStatus(`Loaded ${entries.length} files.`);
      } catch {
        setStatus("Folder scan canceled or failed.");
      }
      return;
    }

    if (directoryInputRef.current) {
      directoryInputRef.current.click();
      return;
    }

    setStatus("Your browser does not support folder picking.");
  };

  const handleDirectoryInputChange = async (
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const fileList = event.target.files;
    if (!fileList || fileList.length === 0) {
      setStatus("Folder scan canceled or failed.");
      return;
    }
    setStatus("Scanning files...");
    const entries: FileEntry[] = [];
    let rootName: string | null = null;

    for (const file of Array.from(fileList)) {
      const relativePath = file.webkitRelativePath || file.name;
      const parts = relativePath.split("/");
      if (!rootName && parts.length > 1) {
        rootName = parts[0];
      }
      if (parts.some((part) => SKIP_DIRS.has(part) || part.startsWith("."))) {
        continue;
      }
      entries.push({
        path: relativePath,
        file,
        size: file.size,
        modified: new Date(file.lastModified).toISOString(),
      });
    }

    setFiles(entries);
    setResults([]);
    setSelectedPaths(new Set());
    setDirectoryName(rootName ?? "Selected folder");
    setStatus(`Loaded ${entries.length} files.`);
    event.target.value = "";
  };

  const handleSearch = async () => {
    const nameInput = query.trim();
    const contentInput = contentQuery.trim();

    if (!nameInput && !contentInput) {
      setResults([]);
      return;
    }

    // Parse include/exclude terms for filename and content
    const nameParsed = parseSearchTerms(nameInput);
    const contentParsed = parseSearchTerms(contentInput);
    const hasContentFilter = contentParsed.include.length > 0 || contentParsed.exclude.length > 0;

    if (files.length === 0) {
      if (isSecretUnlocked && sambaFiles.length > 0) {
        setSambaFilter(nameInput);
        setStatus("Filtroval jsem Samba soubory podle dotazu.");
      } else {
        setStatus("Nejprve vyberte lokální složku.");
      }
      return;
    }
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setIsSearching(true);
    setStatus("Hledám...");

    const matches: FileEntry[] = [];
    for (let index = 0; index < files.length; index += 1) {
      if (controller.signal.aborted) {
        return;
      }
      const entry = files[index];
      const pathNorm = normalizeCzech(entry.path);

      // --- Filename matching ---
      let nameOk = true;
      
      // Wildcard * = match all (just apply excludes)
      const nameIsWildcard = nameParsed.include.length === 1 && nameParsed.include[0] === "*";
      
      if (!nameIsWildcard && nameParsed.include.length > 0) {
        if (searchMode === "and") {
          nameOk = nameParsed.include.every((t) => fuzzyContains(pathNorm, t));
        } else {
          nameOk = nameParsed.include.some((t) => fuzzyContains(pathNorm, t));
        }
      }
      
      // No exclude term may match the path
      if (nameOk && nameParsed.exclude.length > 0) {
        nameOk = !nameParsed.exclude.some((t) => fuzzyContains(pathNorm, t));
      }

      if (!nameOk) {
        if ((index + 1) % SEARCH_BATCH_SIZE === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        continue;
      }

      // --- Days filter (folder files use lastModified from File handle) ---
      if (folderMaxDays > 0 && entry.file) {
        const cutoff = Date.now() - folderMaxDays * 86_400_000;
        if (entry.file.lastModified < cutoff) {
          if ((index + 1) % SEARCH_BATCH_SIZE === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          continue;
        }
      }

      // --- Content matching (only if content filter provided) ---
      let contentOk = true;
      const contentIsWildcard = contentParsed.include.length === 1 && contentParsed.include[0] === "*";
      if (hasContentFilter) {
        try {
          if (entry.size <= MAX_FILE_BYTES) {
            const text = await readFileText(entry, MAX_FILE_BYTES, ocrMaxPages);
            const textNorm = normalizeCzech(text);
            
            if (!contentIsWildcard && contentParsed.include.length > 0) {
              if (searchMode === "and") {
                contentOk = contentParsed.include.every((t) => textNorm.includes(t));
              } else {
                contentOk = contentParsed.include.some((t) => textNorm.includes(t));
              }
            }
            
            if (contentOk && contentParsed.exclude.length > 0) {
              contentOk = !contentParsed.exclude.some((t) => textNorm.includes(t));
            }
          } else {
            contentOk = false;
          }
        } catch {
          contentOk = false;
        }
      }

      if (nameOk && contentOk) {
        matches.push(entry);
      }
      if ((index + 1) % SEARCH_BATCH_SIZE === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    setResults(matches);

    const parts: string[] = [];
    if (nameParsed.include.length) parts.push(`název obsahuje: ${nameParsed.include.join(", ")}`);
    if (nameParsed.exclude.length) parts.push(`název NEobsahuje: ${nameParsed.exclude.join(", ")}`);
    if (contentParsed.include.length) parts.push(`obsah obsahuje: ${contentParsed.include.join(", ")}`);
    if (contentParsed.exclude.length) parts.push(`obsah NEobsahuje: ${contentParsed.exclude.join(", ")}`);
    
    setStatus(
      `Nalezeno ${matches.length} souborů. ${searchMode.toUpperCase()} mód. ${parts.join(" | ")}`
    );
    setIsSearching(false);
  };

  const handleDownloadAllFiles = async () => {
    if (displayedFiles.length === 0) {
      setStatus("Žádné soubory k stažení.");
      return;
    }

    // Download each file
    let downloaded = 0;
    for (const entry of displayedFiles) {
      try {
        if (entry.file) {
          // Use File API to download
          const url = URL.createObjectURL(entry.file);
          const a = document.createElement('a');
          a.href = url;
          a.download = entry.file.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          downloaded++;
          
          // Small delay to avoid overwhelming the browser
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      } catch (error) {
        console.error(`Failed to download ${entry.path}:`, error);
      }
    }
    
    setStatus(`Staženo ${downloaded} souborů.`);
  };

  const toggleSelected = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectAllChecked) {
      setSelectedPaths(new Set());
      setSelectAllChecked(false);
    } else {
      const allPaths = new Set(results.map((entry) => entry.path));
      setSelectedPaths(allPaths);
      setSelectAllChecked(true);
    }
  };

  const handleSambaScan = async () => {
    if (!isSecretUnlocked) {
      setStatus("Samba je dostupná jen po zadání platného přístupového slova (min. 5 znaků).");
      return;
    }
    if (!sambaPath.trim()) {
      setStatus("Enter a Samba path (e.g., /mnt/samba or //server/share)");
      return;
    }
    
    // If already scanning, do nothing (prevent double-click)
    if (isSambaScanning) return;
    
    setIsSambaScanning(true);
    setStatus("Scanning Samba share...");
    try {
      const controller = new AbortController();
      sambaCancelRef.current = controller;
      const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS * 3
      );
      const response = await fetch("/api/samba", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sambaPath: sambaPath.trim(),
          recursive: true,
          maxFiles: 5000,
          nameFilter: sambaFilter.trim(),
          maxDays: sambaMaxDays,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = (await response.json()) as {
        success?: boolean;
        files?: SambaEntry[];
        stats?: SambaStats;
        error?: string;
        suggestedPaths?: Array<{ path: string; name: string }>;
      };
      if (!response.ok && !data.suggestedPaths) {
        throw new Error(data.error ?? "Samba scan failed.");
      }
      
      // Pokud jsou suggestions, zobraz je
      if (data.suggestedPaths && data.suggestedPaths.length > 0) {
        setSambaSuggestedPaths(data.suggestedPaths);
        setStatus(data.error ?? "Nalezeny cesty s prefixem");
        setSambaFiles([]);
        setSambaStats(null);
      } else {
        const files = data.files ?? [];
        setSambaFiles(files);
        setSambaStats(data.stats ?? null);
        setSambaSuggestedPaths([]);
        setLastScannedSambaPath(sambaPath.trim());
        setStatus(
          `✓ Nalezeno ${data.stats?.totalFiles} souborů (${data.stats?.totalSizeGB} GB)`
        );
        
        // Save sambaPath to settings for current secret word
        if (isSecretUnlocked) {
          setSecretWordSettings((prev) => ({
            ...prev,
            sambaPath: sambaPath.trim(),
          }));
        }
        
        if (autoAddSamba) {
          await addSambaFilesToContext(files);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        setStatus("Skenování zrušeno.");
      } else {
        setStatus(
          error instanceof Error ? error.message : "Chyba prohledávání  úložiště."
        );
      }
      setSambaSuggestedPaths([]);
    } finally {
      sambaCancelRef.current = null;
      setIsSambaScanning(false);
    }
  };

  const cancelSambaScan = () => {
    if (sambaCancelRef.current) {
      sambaCancelRef.current.abort();
      sambaCancelRef.current = null;
      setStatus("Skenování zrušeno uživatelem.");
    }
  };

  const handleAddSambaToContext = async (filePath: string) => {
    if (!isSecretUnlocked) {
      setStatus("Přidání Samba souborů je dostupné jen po zadání přístupového slova.");
      return;
    }
    if (fileContext.some((item) => item.path === filePath)) {
      setStatus("Soubor již je v kontextu.");
      return;
    }
    setStatus(`Extrahuji ${filePath}...`);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS * 2
      );
      const response = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath,
          fileName: filePath.split("/").pop() ?? filePath,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = (await response.json()) as {
        success?: boolean;
        text?: string;
        textLength?: number;
        fileName?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "Extraction failed.");
      }
      let text = data.text ?? "";
      const lineCount = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      setFileContext((prev) => [
        ...prev,
        {
          path: filePath,
          content: text,
          size: data.textLength ?? 0,
          lineCount,
        },
      ]);
      try {
        const clipped = text.slice(0, MAX_FILE_BYTES);
        await cachePutText({
          path: filePath,
          text: clipped,
          size: clipped.length,
          storedAt: Date.now(),
        });
      } catch {
        // ignore cache errors
      }
      setStatus(`✓ Added ${data.fileName}`);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Extraction failed."
      );
    }
  };

  const addSambaFilesToContext = async (files: SambaEntry[]) => {
    if (!isSecretUnlocked) {
      setStatus("Přidání Samba souborů je dostupné jen po zadání přístupového slova.");
      return;
    }
    if (isAddingToContext) {
      setStatus("Přidávání do kontextu už běží. Použijte Přerušit.");
      return;
    }
    setIsAddingToContext(true);
    setAddContextMode("samba");
    // Detect changed files (same path but different modified date) — re-extract them
    const changedFiles = files.filter((f) => {
      if (f.type !== "file") return false;
      const existing = fileContext.find((item) => item.path === f.path);
      if (!existing) return false; // new file, handled below
      // If modified dates differ, the file changed
      return f.modified && existing.modified && f.modified !== existing.modified;
    });

    // Remove stale versions of changed files from context
    if (changedFiles.length > 0) {
      const changedPaths = new Set(changedFiles.map((f) => f.path));
      setFileContext((prev) => prev.filter((item) => !changedPaths.has(item.path)));
    }

    // Apply sambaAddFilter before adding
    let filesToAdd = files.filter(
      (f) =>
        f.type === "file" &&
        (changedFiles.some((c) => c.path === f.path) ||
         !fileContext.some((item) => item.path === f.path))
    );
    
    // Filter by sambaAddFilter
    if (sambaAddFilter.trim()) {
      const filterLower = sambaAddFilter.trim().toLowerCase();
      filesToAdd = filesToAdd.filter((f) => 
        f.path.toLowerCase().includes(filterLower) || (f.name && f.name.toLowerCase().includes(filterLower))
      );
    }
    
    if (autoAddLimit > 0) {
      filesToAdd = filesToAdd.slice(0, autoAddLimit);
    }
    if (filesToAdd.length === 0) {
      setStatus("Všechny soubory jsou již v kontextu a aktuální nebo neodpovídají filtru.");
      setIsAddingToContext(false);
      setAddContextMode(null);
      return;
    }
    const newCount = filesToAdd.length - changedFiles.length;
    const changedCount = changedFiles.filter((c) => filesToAdd.some((f) => f.path === c.path)).length;
    const label = [
      newCount > 0 ? `${newCount} nových` : "",
      changedCount > 0 ? `${changedCount} změněných` : "",
    ].filter(Boolean).join(" + ");
    setStatus(`Extrahuji ${filesToAdd.length} souborů (${label})...`);
    setLoadProgress({ label: "Start", percent: 0 });
    
    const controller = new AbortController();
    addFilesAbortRef.current = controller;
    
    let added = 0;
    let failed = 0;
    let cancelled = false;
    let firstError: string | null = null;
    for (let index = 0; index < filesToAdd.length; index += 1) {
      if (controller.signal.aborted) {
        cancelled = true;
        break;
      }
      
      const file = filesToAdd[index];
      try {
        const timeoutId = setTimeout(
          () => controller.abort(),
          REQUEST_TIMEOUT_MS * 2
        );
        const response = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filePath: file.path,
            fileName: file.name,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const data = (await response.json()) as {
          success?: boolean;
          text?: string;
          textLength?: number;
          fileName?: string;
          error?: string;
        };
        if (response.ok) {
          const text = data.text ?? "";
          const lineCount = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
          setFileContext((prev) => [
            ...prev,
            {
              path: file.path,
              content: text,
              size: data.textLength ?? 0,
              lineCount,
              modified: file.modified,
              created: file.created,
            },
          ]);
          try {
            const text = (data.text ?? "").slice(0, MAX_FILE_BYTES);
            await cachePutText({
              path: file.path,
              text,
              size: text.length,
              modified: file.modified,
              created: file.created,
              storedAt: Date.now(),
            });
          } catch {
            // ignore cache errors
          }
          added++;
        } else {
          failed++;
          if (!firstError && data.error) {
            firstError = data.error;
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          cancelled = true;
          break;
        }
        failed++;
      }
      const percent = Math.round(((index + 1) / filesToAdd.length) * 100);
      setLoadProgress({
        label: `${file.name} (${index + 1}/${filesToAdd.length})`,
        percent,
      });
    }
    setLoadProgress(null);
    addFilesAbortRef.current = null;

    if (cancelled) {
      setStatus(`Přidávání přerušeno. Přidáno ${added} souborů.`);
    } else {
      if (added === 0 && failed > 0) {
        setStatus(
          firstError
            ? `Nepodařilo se přidat žádný soubor. ${firstError}`
            : "Nepodařilo se přidat žádný soubor. Zkontrolujte přístup k Samba cestě."
        );
      } else {
        const updatedSuffix = changedCount > 0 ? ` (${changedCount} aktualizováno)` : "";
        setStatus(`✓ Přidáno ${added} souborů do kontextu${updatedSuffix}. Neúspěšné: ${failed}`);
      }
    }
    setIsAddingToContext(false);
    setAddContextMode(null);
  };

  const handleAddAllSambaToContext = async () => {
    const allFiles = sambaFiles.filter((f) => f.type === "file");
    const filtered = filterSambaFiles(allFiles);
    await addSambaFilesToContext(filtered);
  };

  const handleAbortAddToContext = () => {
    if (addFilesAbortRef.current) {
      addFilesAbortRef.current.abort();
      setStatus("Přerušuju přidávání do kontextu...");
    }
  };

  const handleAddToContext = async () => {
    if (isAddingToContext) {
      setStatus("Přidávání do kontextu už běží. Použijte Přerušit.");
      return;
    }
    if (selectedPaths.size === 0) {
      setStatus("Vyberte alespoň jeden soubor z výsledků.");
      return;
    }
    const controller = new AbortController();
    addFilesAbortRef.current = controller;
    setIsAddingToContext(true);
    setAddContextMode("results");
    setStatus("Načítám vybrané soubory...");
    setLoadProgress({ label: "Start", percent: 0 });
    const selectedEntries = results.filter((entry) =>
      selectedPaths.has(entry.path)
    );
    const newContext: FileContext[] = [];
    const existingPaths = new Set(fileContext.map((item) => item.path));
    for (let index = 0; index < selectedEntries.length; index += 1) {
      if (controller.signal.aborted) {
        break;
      }
      const entry = selectedEntries[index];
      if (existingPaths.has(entry.path)) {
        continue;
      }
      try {
        const content = await readFileText(
          entry,
          MAX_FILE_BYTES,
          ocrMaxPages,
          (percent, label) => {
            const fileProgress =
              selectedEntries.length > 0
                ? (index / selectedEntries.length) * 100
                : 0;
            const combined = Math.min(
              99,
              Math.round(fileProgress + percent / selectedEntries.length)
            );
            setLoadProgress({
              label: `${entry.path} • ${label}`,
              percent: combined,
            });
          }
        );
        const lineCount = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
        newContext.push({
          path: entry.path,
          content,
          size: entry.size,
          lineCount,
          modified: entry.modified,
        });
        existingPaths.add(entry.path);
      } catch {
        setStatus(`Failed to read ${entry.path}.`);
      }
      const overall = Math.round(((index + 1) / selectedEntries.length) * 100);
      setLoadProgress({
        label: `Hotovo ${index + 1}/${selectedEntries.length}`,
        percent: overall,
      });
    }
    setFileContext((prev) => [...prev, ...newContext]);
    setSelectedPaths(new Set());
    setLoadProgress(null);
    addFilesAbortRef.current = null;
    setIsAddingToContext(false);
    setAddContextMode(null);
    if (controller.signal.aborted) {
      setStatus(`Přidávání přerušeno. Přidáno ${newContext.length} souborů.`);
    } else {
      setStatus(`Added ${newContext.length} files to context.`);
    }
  };

  const handleAddLocalFilesToContext = async () => {
    if (isAddingToContext) {
      setStatus("Přidávání do kontextu už běží. Použijte Přerušit.");
      return;
    }
    if (selectedLocalFilePaths.size === 0) {
      setStatus("Vyberte alespoň jeden soubor z tabulky.");
      return;
    }
    const controller = new AbortController();
    addFilesAbortRef.current = controller;
    setIsAddingToContext(true);
    setAddContextMode("local");
    setStatus("Načítám vybrané soubory...");
    setLoadProgress({ label: "Start", percent: 0 });
    const selectedEntries = displayedFiles.filter((entry) =>
      selectedLocalFilePaths.has(entry.path)
    );
    const newContext: FileContext[] = [];
    const existingPaths = new Set(fileContext.map((item) => item.path));
    for (let index = 0; index < selectedEntries.length; index += 1) {
      if (controller.signal.aborted) {
        break;
      }
      const entry = selectedEntries[index];
      if (existingPaths.has(entry.path)) {
        continue;
      }
      try {
        const content = await readFileText(
          entry,
          MAX_FILE_BYTES,
          ocrMaxPages,
          (percent, label) => {
            const fileProgress =
              selectedEntries.length > 0
                ? (index / selectedEntries.length) * 100
                : 0;
            const combined = Math.min(
              99,
              Math.round(fileProgress + percent / selectedEntries.length)
            );
            setLoadProgress({
              label: `${entry.path} • ${label}`,
              percent: combined,
            });
          }
        );
        const lineCount = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
        newContext.push({
          path: entry.path,
          content,
          size: entry.size,
          lineCount,
          modified: entry.modified,
        });
        existingPaths.add(entry.path);
      } catch {
        setStatus(`Failed to read ${entry.path}.`);
      }
      const overall = Math.round(((index + 1) / selectedEntries.length) * 100);
      setLoadProgress({
        label: `Hotovo ${index + 1}/${selectedEntries.length}`,
        percent: overall,
      });
    }
    setFileContext((prev) => [...prev, ...newContext]);
    setSelectedLocalFilePaths(new Set());
    setSelectLocalFilesAllChecked(false);
    setLoadProgress(null);
    addFilesAbortRef.current = null;
    setIsAddingToContext(false);
    setAddContextMode(null);
    if (controller.signal.aborted) {
      setStatus(`Přidávání přerušeno. Přidáno ${newContext.length} souborů.`);
    } else {
      setStatus(`Přidáno ${newContext.length} souborů do kontextu.`);
    }
  };

  const handleCreateContext = () => {
    const name = newContextName.trim();
    if (!name) {
      setStatus("Zadejte název kontextu.");
      return;
    }
    // Vygeneruj tajné slovo (8 znaky, alphanumerické)
    const secretKey = Math.random().toString(36).substring(2, 10).toUpperCase();
    const context: SavedContext = {
      id: generateUUID(),
      name,
      secretKey,
      sambaPath: newContextSambaPath.trim(),
      autoSyncMinutes: 0,
      extensions: [],
      notifyOnSync: false,
      files: {},
      uiPaths: [],
    };
    setSavedContexts((prev) => [context, ...prev]);
    setActiveContextId(context.id);
    setNewContextName("");
    setNewContextSambaPath("");
    setStatus(`✓ Kontext "${name}" vytvořen. Tajné slovo: ${secretKey}`);
  };

  const handleUpdateActiveContext = (patch: Partial<SavedContext>) => {
    if (!activeContextId) return;
    setSavedContexts((prev) =>
      prev.map((ctx) =>
        ctx.id === activeContextId ? { ...ctx, ...patch } : ctx
      )
    );
  };

  const handleDeleteActiveContext = () => {
    if (!activeContextId) return;
    setSavedContexts((prev) => {
      const next = prev.filter((ctx) => ctx.id !== activeContextId);
      setActiveContextId(next[0]?.id ?? null);
      return next;
    });
  };

  const computeHash = async (text: string) => {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };

  const handleSyncActiveContext = async () => {
    if (!activeContext) {
      setStatus("Vyberte kontext.");
      return;
    }
    
    if (fileContext.length === 0) {
      setStatus("UI kontext je prázdný. Přidejte soubory do kontextu a pak je synchronizujte.");
      return;
    }
    
    setStatus(`Synchronizuji kontext ${activeContext.name}...`);
    setSyncProgress({ label: "Příprava", percent: 0 });
    setIsSyncing(true);
    
    try {
      const contextPrefix = activeContext.secretKey && activeContext.id
        ? `${activeContext.secretKey}:${activeContext.id}:`
        : activeContext.secretKey
          ? `${activeContext.secretKey}:`
          : "";
      const filesToIndex: Array<{ name: string; content: string }> = [];
      
      // Vezmeme soubory z UI kontextu a přidáme je do indexu s prefixem kontextu
      for (let i = 0; i < fileContext.length; i += 1) {
        const file = fileContext[i];
        filesToIndex.push({
          name: `${contextPrefix}${file.path}`,
          content: file.content,
        });
        
        setSyncProgress({
          label: `Příprava ${i + 1}/${fileContext.length}`,
          percent: Math.round(((i + 1) / fileContext.length) * 50),
        });
      }
      
      if (filesToIndex.length === 0) {
        setStatus("Žádné soubory k synchronizaci.");
        setSyncProgress(null);
        return;
      }
      
      const indexController = new AbortController();
      const indexTimeoutId = window.setTimeout(
        () => indexController.abort(),
        REQUEST_TIMEOUT_MS * 4
      );
      setSyncProgress({ label: "Indexace", percent: 75 });
      
      let indexResponse: Response;
      try {
        indexResponse = await fetch("/api/index", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: filesToIndex,
            incremental: true,
          }),
          signal: indexController.signal,
        });
      } finally {
        window.clearTimeout(indexTimeoutId);
      }
      
      const indexData = (await indexResponse.json()) as {
        error?: string;
        chunksCount?: number;
        filesCount?: number;
        skippedFiles?: Array<{ name: string; reason: string }>;
        embeddingDimension?: number;
      };
      
      if (!indexResponse.ok) {
        throw new Error(indexData.error ?? "Indexing failed.");
      }
      
      setSyncProgress({ label: "Hotovo", percent: 100 });
      setIsIndexed(true);
      
      handleUpdateActiveContext({
        lastIndexedAt: new Date().toISOString(),
      });
      
      const skippedCount = indexData.skippedFiles?.length ?? 0;
      const indexedFiles = Math.max(0, (indexData.filesCount ?? 0) - skippedCount);
      const skippedHint = skippedCount
        ? ` (přeskočeno ${skippedCount} souborů)`
        : "";
      
      setStatus(`✓ Kontext ${activeContext.name} synchronizován. Indexováno: ${indexedFiles} souborů → ${indexData.chunksCount} chunků${skippedHint}`);
      
      if (activeContext.notifyOnSync && notificationsEnabled) {
        new Notification("Synchronizace hotová", {
          body: `Kontext ${activeContext.name} byl úspěšně synchronizován.`,
        });
      }
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Synchronizace selhala."
      );
    } finally {
      setSyncProgress(null);
      setIsSyncing(false);
    }
  };

  const getActiveContextPathsForUiLoad = (): string[] => {
    if (!activeContext) return [];
    const fromUi = Array.isArray(activeContext.uiPaths)
      ? activeContext.uiPaths.filter((p) => typeof p === "string" && p.length > 0)
      : [];
    if (fromUi.length > 0) return fromUi;
    return Object.keys(activeContext.files ?? {});
  };

  const handleSaveUiContextToActiveContext = () => {
    if (!activeContext) {
      setStatus("Vyberte kontext.");
      return;
    }
    const paths = fileContext.map((f) => f.path);
    handleUpdateActiveContext({ uiPaths: paths });
    setStatus(`✓ Uloženo ${paths.length} souborů pro UI kontext do ${activeContext.name}.`);
  };

  const handleLoadUiContextFromActiveContext = async () => {
    if (!activeContext) {
      setStatus("Vyberte kontext.");
      return;
    }
    const allPaths = getActiveContextPathsForUiLoad();
    if (allPaths.length === 0) {
      setStatus("V uloženém kontextu nejsou žádné soubory.");
      return;
    }

    const limit = Math.max(1, Math.min(5000, uiLoadLimit || 0));
    const paths = allPaths.slice(0, limit);

    setStatus(
      uiLoadCacheOnly
        ? `Načítám UI kontext z cache (${paths.length})...`
        : `Načítám UI kontext (cache + extract) (${paths.length})...`
    );
    setLoadProgress({ label: "Start", percent: 0 });

    let loaded = 0;
    let loadedFromCache = 0;
    let extracted = 0;
    let missing = 0;
    const batch: FileContext[] = [];
    const BATCH_FLUSH = 25;

    for (let i = 0; i < paths.length; i += 1) {
      const path = paths[i];
      if (fileContext.some((f) => f.path === path)) {
        continue;
      }

      const percent = Math.round(((i + 1) / paths.length) * 100);
      setLoadProgress({ label: `${path.split("/").pop() ?? path} (${i + 1}/${paths.length})`, percent });

      let text: string | null = null;
      try {
        const cached = await cacheGetText(path);
        if (cached?.text) {
          text = cached.text;
          loadedFromCache += 1;
        }
      } catch {
        // ignore cache errors; fallback to extract if allowed
      }

      if (!text && !uiLoadCacheOnly) {
        try {
          const controller = new AbortController();
          const timeoutId = window.setTimeout(
            () => controller.abort(),
            REQUEST_TIMEOUT_MS * 2
          );
          let response: Response;
          try {
            response = await fetch("/api/extract", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                filePath: path,
                fileName: path.split("/").pop() ?? path,
              }),
              signal: controller.signal,
            });
          } finally {
            window.clearTimeout(timeoutId);
          }
          const data = (await response.json()) as { text?: string };
          if (response.ok && data.text) {
            text = data.text;
            extracted += 1;
            try {
              const clipped = text.slice(0, MAX_FILE_BYTES);
              await cachePutText({
                path,
                text: clipped,
                size: clipped.length,
                storedAt: Date.now(),
              });
              text = clipped;
            } catch {
              // ignore cache put errors
            }
          }
        } catch {
          // ignore per-file extract errors
        }
      }

      if (!text) {
        missing += 1;
        continue;
      }

      batch.push({ path, content: text, size: text.length, lineCount: text.split('\n').length - (text.endsWith('\n') ? 1 : 0) });
      loaded += 1;
      if (batch.length >= BATCH_FLUSH) {
        const toAdd = batch.splice(0, batch.length);
        setFileContext((prev) => [...prev, ...toAdd]);
      }
    }

    if (batch.length > 0) {
      setFileContext((prev) => [...prev, ...batch]);
    }
    setLoadProgress(null);
    setStatus(
      `✓ Načteno do UI kontextu: ${loaded} (cache: ${loadedFromCache}, extract: ${extracted}, chybí: ${missing}). ` +
        `Tip: pro 2300 souborů držte limit níž (např. 200–500).`
    );
  };

  useEffect(() => {
    if (!activeContext || activeContext.autoSyncMinutes <= 0) {
      return;
    }
    const interval = window.setInterval(() => {
      handleSyncActiveContext();
    }, activeContext.autoSyncMinutes * 60_000);
    return () => window.clearInterval(interval);
  }, [activeContext?.id, activeContext?.autoSyncMinutes]);

  // Secret word validation and context auto-load/create
  useEffect(() => {
    if (secretWord.length < 5) {
      setSecretWordCheckingStatus(null);
      return;
    }
    
    // For now, just validate that it's 5+ characters
    // In the future, this could query DB to check if context exists
    setSecretWordCheckingStatus(null);
  }, [secretWord]);

  // Load saved secret words from localStorage on mount
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = localStorage.getItem("nai.savedSecretWords.v1");
      if (saved) {
        setSavedSecretWords(JSON.parse(saved));
      }
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Save valid secret words to localStorage
  useEffect(() => {
    if (secretWord.length >= 5 && typeof window !== "undefined") {
      try {
        const updated = Array.from(new Set([secretWord, ...savedSecretWords])).slice(0, 20);
        localStorage.setItem("nai.savedSecretWords.v1", JSON.stringify(updated));
        setSavedSecretWords(updated);
      } catch {
        // Ignore localStorage errors
      }
    }
  }, [secretWord]);

  // Load settings for current secret word from localStorage
  useEffect(() => {
    if (!isSecretUnlocked || typeof window === "undefined") {
      setSecretWordSettings(DEFAULT_SECRET_WORD_SETTINGS);
      setSambaPath("");
      setSambaFilter("");
      setSambaContentFilter("");
      setSambaMaxDays(0);
      setAutoAddSamba(false);
      setAutoAddLimit(0);
      return;
    }
    const merged = loadSecretWordSettings(normalizedSecretWord);
    setSecretWordSettings(merged);
    setSambaPath(merged.sambaPath);
    setSambaFilter(merged.sambaFilter);
    setSambaContentFilter(merged.sambaContentFilter);
    setSambaMaxDays(Math.max(0, merged.sambaMaxDays));
    setAutoAddSamba(Boolean(merged.autoAddSamba));
    setAutoAddLimit(Math.max(0, merged.autoAddLimit));
    setQuery(merged.query);
    setContentQuery(merged.contentQuery);
    setFolderMaxDays(Math.max(0, merged.folderMaxDays));
    setSearchMode(merged.searchMode);
    setOcrMaxPages(merged.ocrMaxPages);
  }, [isSecretUnlocked, normalizedSecretWord]);

  // Load chat history for current secret word from localStorage
  useEffect(() => {
    if (typeof window === "undefined" || !isSecretUnlocked) {
      setChatHistory([]);
      return;
    }
    setChatHistory(loadChatHistoryForWord(normalizedSecretWord));
  }, [isSecretUnlocked, normalizedSecretWord]);

  const handleDeleteSecretWord = async () => {
    if (!secretWord || secretWord.length < 5) return;
    
    const confirmed = window.confirm(
      `Opravdu chcete smazat slovo "${secretWord}" a VŠECHNA zaindexovaná data z databáze? Tato akce je nevratná!`
    );
    if (!confirmed) return;

    setIsDeletingSecretWord(true);
    setStatus("Mažu data z databáze...");
    
    try {
      const response = await fetch("/api/index/delete-by-prefix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: `${secretWord}:` }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error ?? "Smazání dat selhalo.");
      }

      // Remove from localStorage
      if (typeof window !== "undefined") {
        try {
          const key = `nai.secretWordSettings.${secretWord}`;
          localStorage.removeItem(key);
          
          // Remove from saved words list
          const updated = savedSecretWords.filter(w => w !== secretWord);
          localStorage.setItem("nai.savedSecretWords.v1", JSON.stringify(updated));
          setSavedSecretWords(updated);
        } catch {
          // Ignore localStorage errors
        }
      }

      setSecretWord("");
      setSecretWordSettings(DEFAULT_SECRET_WORD_SETTINGS);
      setFileContext([]);
      setIsIndexed(false);
      setStatus(`✓ Slovo "${secretWord}" a ${data.deletedCount ?? 0} záznamů bylo smazáno.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Smazání dat selhalo.");
    } finally {
      setIsDeletingSecretWord(false);
    }
  };

  const handleRemoveSavedWord = (wordToRemove: string) => {
    if (typeof window === "undefined") return;
    try {
      const updated = savedSecretWords.filter(w => w !== wordToRemove);
      localStorage.setItem("nai.savedSecretWords.v1", JSON.stringify(updated));
      setSavedSecretWords(updated);
      
      // Also remove settings
      const key = `nai.secretWordSettings.${wordToRemove}`;
      localStorage.removeItem(key);
    } catch {
      // Ignore localStorage errors
    }
  };

  const handleEnableNotifications = async () => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setStatus("Notifikace nejsou v tomto prohlížeči podporovány.");
      return;
    }
    if (Notification.permission === "granted") {
      setNotificationsEnabled(true);
      return;
    }
    const permission = await Notification.requestPermission();
    setNotificationsEnabled(permission === "granted");
    if (permission !== "granted") {
      setStatus("Notifikace nebyly povoleny.");
    }
  };

  const handleRemoveContext = (path: string) => {
    setFileContext((prev) => prev.filter((item) => item.path !== path));
  };

  const handleIndexFiles = async () => {
    if (!isSecretUnlocked) {
      setStatus("Zadejte platné přístupové slovo (min. 5 znaků) pro indexaci.");
      return;
    }
    if (fileContext.length === 0) {
      setStatus("Add files to context first.");
      return;
    }
    setIsIndexing(true);
    setStatus("Indexing files...");
    setIndexProgress({ label: "Příprava", percent: 0 });
    try {
      const contextPrefix = normalizedSecretWord ? `${normalizedSecretWord}:` : "";
      const filesPayload = fileContext.map((f, index) => {
        const percent = Math.round(((index + 1) / fileContext.length) * 50);
        setIndexProgress({
          label: `Příprava ${index + 1}/${fileContext.length}`,
          percent,
        });
        return {
          name: contextPrefix ? `${contextPrefix}${f.path}` : f.path,
          content: f.content,
        };
      });
      const controller = new AbortController();
      indexAbortRef.current = controller;
      const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS * 2
      );
      setIndexProgress({ label: "Odesílání a indexace", percent: 75 });
      const response = await fetch("/api/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: filesPayload,
          incremental: true, // Enable incremental indexing
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      indexAbortRef.current = null;
      const data = (await response.json()) as {
        success?: boolean;
        message?: string;
        chunksCount?: number;
        filesCount?: number;
        skippedFiles?: Array<{ name: string; reason: string }>;
        skippedEmptyChunks?: number;
        embeddingDimension?: number;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "Indexing failed.");
      }
      setIndexProgress({ label: "Hotovo", percent: 100 });
      setIsIndexed(true);
      const skippedCount = data.skippedFiles?.length ?? 0;
      const indexedFiles = Math.max(0, (data.filesCount ?? 0) - skippedCount);
      const skippedSample = data.skippedFiles?.slice(0, 3).map((x) => x.name) ?? [];
      const skippedSuffix = skippedCount
        ? `; přeskočeno ${skippedCount}/${data.filesCount} souborů (např. ${skippedSample.join(", ")}${skippedCount > skippedSample.length ? ", …" : ""})`
        : "";
      const dimSuffix = data.embeddingDimension
        ? `; dim=${data.embeddingDimension}`
        : "";

      setStatus(
        `✓ Indexed ${indexedFiles}/${data.filesCount} souborů → ${data.chunksCount} chunků${skippedSuffix}${dimSuffix}`
      );
      
      // Update lastIndexedAt in settings
      const indexedAtIso = new Date().toISOString();
      const nextSaved = buildSettingsFromCurrentUi({ lastIndexedAt: indexedAtIso });
      setSecretWordSettings(nextSaved);
      persistSecretWordSettings(normalizedSecretWord, nextSaved);
      
      // Refresh Knowledge Base status
      if (isSecretUnlocked) {
        try {
          const prefix = `${normalizedSecretWord}:`;
          const kbRes = await fetch(`/api/knowledge-base/status?prefix=${encodeURIComponent(prefix)}`);
          const kbData = await kbRes.json();
          if (kbRes.ok) {
            setKnowledgeBase({
              initialized: kbData.initialized ?? false,
              totalFiles: kbData.totalFiles ?? 0,
              totalChunks: kbData.totalChunks ?? 0,
              embeddingDimension: kbData.embeddingDimension ?? null,
              lastIndexedAt: kbData.lastIndexedAt ?? null,
              readyForSearch: kbData.readyForSearch ?? false,
            });
          }
        } catch {
          // Ignore KB refresh errors
        }
      }
    } catch (error) {
      // Check if it's an abort error
      if (error instanceof Error && error.name === "AbortError") {
        setStatus("Indexace přerušena uživatelem.");
      } else {
        setStatus(
          error instanceof Error ? error.message : "Indexing failed."
        );
      }
    } finally {
      setIsIndexing(false);
      setTimeout(() => setIndexProgress(null), 800);
    }
  };

  const handleRebuildIndex = async (mode: "drop" | "truncate") => {
    if (!isSecretUnlocked) {
      setStatus("Rebuild indexu je dostupný jen po zadání přístupového slova.");
      return;
    }
    if (isRebuilding) return;
    if (typeof window !== "undefined") {
      const promptMessage =
        mode === "truncate"
          ? "Opravdu chcete vycistit index? Tato akce smaze vsechny radky v file_index."
          : "Opravdu chcete rebuildnout index? Tato akce smaze tabulku file_index a je nevratna.";
      const confirmed = window.confirm(promptMessage);
      if (!confirmed) return;
    }
    setIsRebuilding(true);
    setStatus(mode === "truncate" ? "Cistim index..." : "Probíhá rebuild indexu...");
    try {
      const response = await fetch(`/api/index/rebuild?mode=${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = (await response.json()) as { success?: boolean; message?: string; error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "Rebuild failed.");
      }
      setIsIndexed(false);
      setDbIndexStatus({ checked: true, hasAnyIndex: false, hasContextIndex: false });
      setStatus(
        data.message ??
          (mode === "truncate"
            ? "Index vycisten. Spustte novou indexaci."
            : "Index smazan. Spustte novou indexaci.")
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Rebuild failed.");
    } finally {
      setIsRebuilding(false);
    }
  };

  const handleSend = async () => {
    const trimmed = chatInput.trim();
    if (!trimmed) {
      return;
    }
    setIsSending(true);
    setStatus(null);
    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
    setChatInput("");
    const historyId = recordChatQueryStart(secretWord, trimmed);
    let chatOk = true;
    let didTimeout = false;
    try {
      const asksToDeduplicateContext =
        /(duplicit|duplicate)/i.test(trimmed) &&
        /(kontext|context)/i.test(trimmed) &&
        /(vycist|vyčist|odstran|smaz|promaz|procist|pročist)/i.test(trimmed);

      if (asksToDeduplicateContext) {
        if (isAddingToContext) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              text: "Právě běží přidávání do kontextu. Nejdřív ho přerušte a pak znovu spusťte čištění duplicit.",
            },
          ]);
          return;
        }
        if (fileContext.length === 0) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              text: "UI kontext je prázdný, není co deduplikovat.",
            },
          ]);
          return;
        }

        const seen = new Set<string>();
        const deduped: FileContext[] = [];
        for (const file of fileContext) {
          if (seen.has(file.path)) continue;
          seen.add(file.path);
          deduped.push(file);
        }
        const removed = fileContext.length - deduped.length;
        setFileContext(deduped);
        setStatus(`Deduplikace hotova: odstraněno ${removed} duplicit.`);
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text:
              removed > 0
                ? `Hotovo. Odstranil jsem ${removed} duplicitních položek. V kontextu zůstává ${deduped.length} unikátních souborů.`
                : `V kontextu jsem nenašel žádné duplicity. Zůstává ${deduped.length} souborů.`,
          },
        ]);
        return;
      }

      const asksToClearContext =
        /(kontext|context)/i.test(trimmed) &&
        /(promaz|vymaz|smaz|vycist|vyčist|reset)/i.test(trimmed) &&
        !/(duplicit|duplicate)/i.test(trimmed);

      if (asksToClearContext) {
        if (isAddingToContext) {
          handleAbortAddToContext();
        }
        const removed = fileContext.length;
        setFileContext([]);
        setSelectedPaths(new Set());
        setSelectedLocalFilePaths(new Set());
        setSelectAllChecked(false);
        setSelectLocalFilesAllChecked(false);
        setStatus("UI kontext byl vymazán.");
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text: `Hotovo. Smazal jsem UI kontext (${removed} souborů). Databázový index zůstává beze změny.`,
          },
        ]);
        return;
      }

      const asksWhatDataWeHave =
        /(s\s*jak(ymi|ými)\s*daty|jak(a|á)\s*data|co\s*m(a|á)me\s*k\s*dispozici|co\s*je\s*v\s*kontextu)/i.test(
          trimmed
        );

      if (asksWhatDataWeHave) {
        if (fileContext.length > 0) {
          const extensionCounts = new Map<string, number>();
          for (const file of fileContext) {
            const ext = getExtension(file.path);
            extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1);
          }
          const extensionSummary = Array.from(extensionCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([ext, count]) => `${ext}: ${count}`)
            .join(", ");
          const sampleLimit = 10;
          const sampleList = fileContext
            .slice(0, sampleLimit)
            .map((file) => `- ${file.path}`)
            .join("\n");
          const remaining = Math.max(0, fileContext.length - sampleLimit);
          const suffix = remaining > 0 ? `\n... a dalších ${remaining} souborů` : "";

          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              text:
                `V UI kontextu mám ${fileContext.length} souborů. Typy: ${extensionSummary || "(nezjištěno)"}.\n\nUkázka souborů:\n${sampleList}${suffix}`,
            },
          ]);
          return;
        }

        if (hasDbIndex) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              text:
                "UI kontext je teď prázdný (nemám v prohlížeči načtené texty souborů), ale data jsou zaindexovaná v databázi. " +
                "Můžeme tedy pracovat přes vyhledávání nad DB (RAG) – ptejte se normálně na obsah datasetu. " +
                "Pokud chcete lokální výpočty nad CSV (řádky, agregace po měsících apod.), použijte tlačítko „Načíst do UI kontextu“.",
            },
          ]);
          return;
        }

        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text:
              "UI kontext je teď prázdný. Přidejte soubory do kontextu a pak můžu shrnout, co v nich je.",
          },
        ]);
        return;
      }

      const wantsOrdersByYearMonth =
        /(objednav|order)/i.test(trimmed) &&
        /(rok|year)/i.test(trimmed) &&
        /(mesic|měsíc|month)/i.test(trimmed);

      if (wantsOrdersByYearMonth) {
        if (fileContext.length === 0) {
          if (!hasDbIndex) {
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                text:
                  "Teď nemám načtený žádný obsah souborů v kontextu. Přidejte CSV soubory do Kontextu a pak spočítám objednávky po měsících.",
              },
            ]);
            return;
          }

          setStatus("Počítám objednávky po měsících z databáze...");
          const response = await fetch("/api/analytics/orders-by-month", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              secretWord: normalizedSecretWord || undefined,
            }),
          });
          const data = (await response.json()) as {
            byMonth?: Array<{ ym: string; count: number }>;
            filesUsed?: number;
            rowsUsed?: number;
            rowsSkipped?: number;
            usedUniqueOrderIds?: boolean;
            notes?: string[];
            error?: string;
          };
          if (!response.ok) {
            throw new Error(data.error ?? "Orders analysis failed.");
          }
          const byMonth = data.byMonth ?? [];
          if (byMonth.length === 0) {
            const notes = data.notes?.length
              ? `\n\nPoznámky:\n- ${data.notes.join("\n- ")}`
              : "";
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                text:
                  `Nepodařilo se spočítat objednávky po měsících z databáze. (Soubory použité ke čtení: ${data.filesUsed ?? 0}, řádků: ${data.rowsUsed ?? 0}, přeskočeno: ${data.rowsSkipped ?? 0})${notes}`,
              },
            ]);
            return;
          }

          const header =
            "| Rok | Měsíc | Počet objednávek |\n|---:|---:|---:|";
          const rows = byMonth
            .map(({ ym, count }) => {
              const [y, m] = ym.split("-");
              return `| ${y} | ${m} | ${count} |`;
            })
            .join("\n");
          const notes = data.notes?.length
            ? `\n\nPoznámky:\n- ${data.notes.join("\n- ")}`
            : "";
          const method = data.usedUniqueOrderIds
            ? "unikátní orderId (deduplikace)"
            : "počet řádků (bez deduplikace)";

          // Create chart from all orders
          const chartLabels = byMonth.map((item) => item.ym);
          const chartSeries = byMonth.map((item) => item.count);
          setAssistantCharts((prev) => [
            ...prev,
            {
              id: `chart-${Date.now()}`,
              title: "Objednávky po měsících (všechny soubory)",
              type: "bar",
              labels: chartLabels,
              series: chartSeries,
            },
          ]);

          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              text:
                `Počet objednávek za každý rok a měsíc (metoda: ${method}).\n` +
                `Zpracováno: ${data.filesUsed ?? 0} CSV/TSV souborů; řádků: ${data.rowsUsed ?? 0}; přeskočeno: ${data.rowsSkipped ?? 0}.\n\n` +
                `${header}\n${rows}${notes}`,
            },
          ]);
          return;
        }

        setStatus(`Počítám objednávky po měsících z ${fileContext.length} souborů...`);
        const result = await computeOrdersByYearMonth(fileContext);
        if (result.byMonth.length === 0) {
          const notes = result.notes.length ? `\n\nPoznámky:\n- ${result.notes.join("\n- ")}` : "";
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              text:
                `Nepodařilo se spočítat objednávky po měsících z načteného kontextu. (Soubory použité ke čtení: ${result.filesUsed}, řádků: ${result.rowsUsed}, přeskočeno: ${result.rowsSkipped})${notes}`,
            },
          ]);
          return;
        }

        const header =
          "| Rok | Měsíc | Počet objednávek |\n|---:|---:|---:|";
        const rows = result.byMonth
          .map(({ ym, count }) => {
            const [y, m] = ym.split("-");
            return `| ${y} | ${m} | ${count} |`;
          })
          .join("\n");
        const notes = result.notes.length ? `\n\nPoznámky:\n- ${result.notes.join("\n- ")}` : "";
        const method = result.usedUniqueOrderIds
          ? "unikátní orderId (deduplikace)"
          : "počet řádků (bez deduplikace)";

        // Create chart from local context
        const chartLabels = result.byMonth.map((item) => item.ym);
        const chartSeries = result.byMonth.map((item) => item.count);
        setAssistantCharts((prev) => [
          ...prev,
          {
            id: `chart-${Date.now()}`,
            title: "Objednávky po měsících (načtený kontext)",
            type: "bar",
            labels: chartLabels,
            series: chartSeries,
          },
        ]);

        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text:
              `Počet objednávek za každý rok a měsíc (metoda: ${method}).\n` +
              `Zpracováno: ${result.filesUsed} CSV/TSV souborů; řádků: ${result.rowsUsed}; přeskočeno: ${result.rowsSkipped}.\n\n` +
              `${header}\n${rows}${notes}`,
          },
        ]);
        return;
      }

      // Handler for orders by state
      const wantsOrdersByState =
        /(objednav|order)/i.test(trimmed) &&
        /(stat|state|country|zem)/i.test(trimmed);

      if (wantsOrdersByState) {
        if (fileContext.length === 0 && !hasDbIndex) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              text:
                "Teď nemám načtený žádný obsah souborů v kontextu a data nejsou v databázi. Přidejte CSV soubory do Kontextu nebo synchronizujte Samba kontext.",
            },
          ]);
          return;
        }

        if (fileContext.length === 0 && hasDbIndex) {
          setStatus("Počítám objednávky po státech z databáze...");
          const response = await fetch("/api/analytics/orders-by-state", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              secretWord: normalizedSecretWord || undefined,
            }),
          });
          const data = (await response.json()) as {
            byState?: Array<{ state: string; count: number }>;
            filesUsed?: number;
            rowsUsed?: number;
            rowsSkipped?: number;
            usedUniqueOrderIds?: boolean;
            notes?: string[];
            error?: string;
          };
          if (!response.ok) {
            throw new Error(data.error ?? "Orders by state analysis failed.");
          }
          const byState = data.byState ?? [];
          if (byState.length === 0) {
            const notes = data.notes?.length
              ? `\n\nPoznámky:\n- ${data.notes.join("\n- ")}`
              : "";
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                text:
                  `Nepodařilo se spočítat objednávky po státech z databáze. (Soubory použité ke čtení: ${data.filesUsed ?? 0}, řádků: ${data.rowsUsed ?? 0}, přeskočeno: ${data.rowsSkipped ?? 0})${notes}`,
              },
            ]);
            return;
          }

          const header = "| Stát | Počet objednávek |\n|:---|---:|";
          const rows = byState
            .map(({ state, count }) => `| ${state} | ${count} |`)
            .join("\n");
          const notes = data.notes?.length
            ? `\n\nPoznámky:\n- ${data.notes.join("\n- ")}`
            : "";
          const method = data.usedUniqueOrderIds
            ? "unikátní orderId (deduplikace)"
            : "počet řádků (bez deduplikace)";

          // Create chart from all states
          const chartLabels = byState.map((item) => item.state);
          const chartSeries = byState.map((item) => item.count);
          setAssistantCharts((prev) => [
            ...prev,
            {
              id: `chart-${Date.now()}`,
              title: "Objednávky po státech (všechny soubory)",
              type: "bar",
              labels: chartLabels,
              series: chartSeries,
            },
          ]);

          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              text:
                `Počet objednávek za každý stát (metoda: ${method}).\n` +
                `Zpracováno: ${data.filesUsed ?? 0} CSV/TSV souborů; řádků: ${data.rowsUsed ?? 0}; přeskočeno: ${data.rowsSkipped ?? 0}.\n\n` +
                `${header}\n${rows}${notes}`,
            },
          ]);
          return;
        }

        // Analyze from local file context
        setStatus(`Počítám objednávky po státech z ${fileContext.length} souborů...`);
        const result = await computeOrdersByState(fileContext);
        if (result.byState.length === 0) {
          const notes = result.notes.length ? `\n\nPoznámky:\n- ${result.notes.join("\n- ")}` : "";
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              text:
                `Nepodařilo se spočítat objednávky po státech z načteného kontextu. (Soubory použité ke čtení: ${result.filesUsed}, řádků: ${result.rowsUsed}, přeskočeno: ${result.rowsSkipped})${notes}`,
            },
          ]);
          return;
        }

        const header = "| Stát | Počet objednávek |\n|:---|---:|";
        const rows = result.byState
          .map(({ state, count }) => `| ${state} | ${count} |`)
          .join("\n");
        const notes = result.notes.length ? `\n\nPoznámky:\n- ${result.notes.join("\n- ")}` : "";
        const method = result.usedUniqueOrderIds
          ? "unikátní orderId (deduplikace)"
          : "počet řádků (bez deduplikace)";

        // Create chart from local context
        const chartLabels = result.byState.map((item) => item.state);
        const chartSeries = result.byState.map((item) => item.count);
        setAssistantCharts((prev) => [
          ...prev,
          {
            id: `chart-${Date.now()}`,
            title: "Objednávky po státech (načtený kontext)",
            type: "bar",
            labels: chartLabels,
            series: chartSeries,
          },
        ]);

        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text:
              `Počet objednávek za každý stát (metoda: ${method}).\n` +
              `Zpracováno: ${result.filesUsed} CSV/TSV souborů; řádků: ${result.rowsUsed}; přeskočeno: ${result.rowsSkipped}.\n\n` +
              `${header}\n${rows}${notes}`,
          },
        ]);
        return;
      }

      // Přímá otázka na počet souborů v kontextu (lokální odpověď, respektuje filtr)
      // Flexible pattern to catch typos like "koliok", "soubpru", "souboru", "soubory"
      const isContextFileCountQuestion =
        /\bkoli\w*/i.test(trimmed) &&
        /\bsoub\w*/i.test(trimmed) &&
        /kontext/i.test(trimmed);

      if (isContextFileCountQuestion) {
        const totalFiles = fileContext.length;
        const filteredFiles = filteredContext.length;
        const hasFilter = contextFilter.trim().length > 0;
        const effectiveFiltered = hasFilter && filteredFiles !== totalFiles;
        const filesForStats = effectiveFiltered ? filteredContext : fileContext;
        const totalLines = filesForStats.reduce((sum, f) => sum + (f.lineCount || 0), 0);
        const totalSize = filesForStats.reduce((sum, f) => sum + (f.size || 0), 0);
        const formatSize = (bytes: number) => {
          if (bytes < 1024) return `${bytes} B`;
          if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
          if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
          return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
        };

        const response = totalFiles === 0
          ? "V kontextu nemáte žádné soubory."
          : effectiveFiltered
            ? `V kontextu máte celkem ${totalFiles} souborů. Pro práci jsou připraveny ${filteredFiles} soubory (filtrováno podle cesty), celkem asi ${totalLines.toLocaleString('cs-CZ')} řádků a ${formatSize(totalSize)}.`
            : `V kontextu máte ${totalFiles} souborů, celkem asi ${totalLines.toLocaleString('cs-CZ')} řádků a ${formatSize(totalSize)}.`;

        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text: response,
          },
        ]);
        return;
      }

      // Otázky o metadatech/stavu systému (před počítáním výskytů v souborech)
      const asksAboutSystemStatus =
        /(kolik\s*(je|m[aá]m|m[aá]me|obsahuje|načten[ýo]|v|zaindexovan[ýo])\s*(soubor[ůy]|chunk[ůy]|dokument[ůy]|text[ůy])(\s*(v|v\s*)?(kontext|databáz|knowledge|kb))?)|(počet\s*(soubor[ůy]|chunk[ůy]|dokument[ůy]))|(jak\s*(velk[áý]|velk[éý])\s*(je\s*)?(databáze|db|knowledge\s*base|kontext))|(co\s*je\s*v\s*knowledge\s*base)/i.test(
          trimmed
        );

      if (asksAboutSystemStatus) {
        const kbInfo = [];
        if (knowledgeBase && knowledgeBase.totalFiles > 0) {
          kbInfo.push(`📁 Celkem zaindexováno souborů: **${knowledgeBase.totalFiles}**`);
        }
        if (knowledgeBase && knowledgeBase.totalChunks > 0) {
          kbInfo.push(`📦 Celkem chunks (textových bloků): **${knowledgeBase.totalChunks}**`);
        }
        if (knowledgeBase && knowledgeBase.embeddingDimension) {
          kbInfo.push(`📐 Dimenze embeddings: **${knowledgeBase.embeddingDimension}**`);
        }
        if (knowledgeBase && knowledgeBase.lastIndexedAt) {
          const date = new Date(knowledgeBase.lastIndexedAt);
          kbInfo.push(`🕒 Poslední indexace: **${date.toLocaleString("cs-CZ")}**`);
        }
        if (fileContext.length > 0) {
          kbInfo.push(`\n💾 V UI kontextu (prohlížeč): **${fileContext.length} souborů** (${(contextText.length / 1024).toFixed(1)} KB textu)`);
        } else {
          kbInfo.push(`\n💾 UI kontext: **prázdný** (můžete načíst soubory tlačítkem "Načíst do UI kontextu")`);
        }
        
        const infoText = (knowledgeBase && knowledgeBase.totalFiles > 0) || fileContext.length > 0
          ? `${knowledgeBase?.readyForSearch ? 'Knowledge base je připravena k vyhledávání:\n\n' : ''}${kbInfo.join("\n")}`
          : "Knowledge base zatím není inicializována a UI kontext je prázdný.";
          
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text: infoText,
          },
        ]);
        return;
      }

      // Local utility: counting string occurrences across currently loaded file contents.
      // This avoids model hallucinations and works even when context is truncated.
      const isCountRequest =
        /\bkolik\b/i.test(trimmed) &&
        /soubor/i.test(trimmed);
      
      // Special case: questions about file count in context should go to API
      const isContextFileCountRequest = 
        isCountRequest &&
        /kontext/i.test(trimmed);
      
      if (isCountRequest && !isContextFileCountRequest) {
        const wantsLineCountsPerFile =
          /(radk|řádk)/i.test(trimmed) &&
          /(kazd|každ)/i.test(trimmed);

        if (wantsLineCountsPerFile) {
          if (fileContext.length === 0) {
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                text:
                  "Teď nemám načtený žádný obsah souborů v kontextu. Přidejte soubory do Kontextu a pak spočítám řádky.",
              },
            ]);
            return;
          }

          setStatus(`Počítám řádky ve ${fileContext.length} souborech...`);
          const stats: Array<{ path: string; count: number }> = [];
          let total = 0;
          for (let i = 0; i < fileContext.length; i += 1) {
            const f = fileContext[i];
            const lines = countLinesFast(f.content);
            total += lines;
            stats.push({ path: f.path, count: lines });
            if ((i + 1) % 50 === 0) {
              // Yield to keep the UI responsive for large contexts.
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
          }

          stats.sort((a, b) => b.count - a.count);
          const top = stats.slice(0, 20);
          const topLines = top.map((x) => `- ${x.path}: ${x.count}`).join("\n");

          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              text:
                `Počet řádků podle souboru (načtený kontext: ${fileContext.length} souborů).\n` +
                `Celkem řádků: ${total}.\n\n` +
                `Top soubory podle počtu řádků:\n${topLines}`,
            },
          ]);
          return;
        }

        const needle = extractCountNeedle(trimmed);
        if (!needle) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              text:
                "Napište prosím přesně, co mám počítat (např. kolik je ve všech souborech \"orderid\").",
            },
          ]);
          return;
        }
        if (fileContext.length === 0) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              text:
                "Teď nemám načtený žádný obsah souborů v kontextu. Přidejte soubory do Kontextu a pak to spočítám.",
            },
          ]);
          return;
        }

        const looksLikeCsvCount = /sloupc|column/i.test(trimmed);
        const needleLower = needle.toLowerCase();
        const hits = fileContext
          .map((f) => {
            const contentLower = f.content.toLowerCase();
            const likelyCsv =
              /\.(csv|tsv)(\s|$)/i.test(f.path) ||
              /\n/.test(f.content) && (f.content.includes(",") || f.content.includes(";") || f.content.includes("\t"));
            if (looksLikeCsvCount && likelyCsv) {
              return {
                path: f.path,
                count: countCsvColumnValues(f.content, needleLower),
                mode: "csv_column" as const,
              };
            }
            return {
              path: f.path,
              count: countOccurrences(contentLower, needleLower),
              mode: "substring" as const,
            };
          })
          .filter((x) => x.count > 0)
          .sort((a, b) => b.count - a.count);
        const total = hits.reduce((sum, x) => sum + x.count, 0);

        const top = hits.slice(0, 10);
        const topLines = top.length
          ? top.map((x) => `- ${x.path}: ${x.count}`).join("\n")
          : "(nenalezeno v žádném načteném souboru)";

        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text:
              looksLikeCsvCount
                ? `V načteném kontextu jsem napočítal celkem ${total} hodnot ve sloupci "${needle}" napříč ${hits.length} soubory (z ${fileContext.length} načtených).\n\nTop soubory:\n${topLines}`
                : `V načteném kontextu jsem našel celkem ${total} výskytů řetězce "${needle}" ve ${hits.length} souborech (z ${fileContext.length} načtených).\n\nTop soubory:\n${topLines}`,
          },
        ]);
        return;
      }

      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, CHAT_REQUEST_TIMEOUT_MS);

      // Check if UI filter is active
      const hasActiveFilter = contextFilter.trim().length > 0 && filteredContext.length !== fileContext.length;
      
      // Use indexed search ONLY if available AND no active UI filter
      // When filter is active, user explicitly wants to work with specific files
      const useIndexedSearch = isSecretUnlocked && hasDbIndex && !hasActiveFilter;
      const endpoint = useIndexedSearch ? "/api/search" : "/api/gemini";
      
      console.log(`[Chat] Endpoint: ${endpoint}, Reason: ${
        !hasDbIndex ? 'no index available' : 
        hasActiveFilter ? `UI filter active (${filteredContext.length}/${fileContext.length} files)` :
        'using indexed search'
      }`);
      
      // Build body with filtering info
      const filteredContextToUse = filteredContext.length > 0 ? buildContext(filteredContext) : buildContext(fileContext);
      const filesToUse = filteredContext.length > 0 ? filteredContext : fileContext;
      const totalFilesCount = fileContext.length;
      const filteredFilesCount = filesToUse.length;
      const totalLinesCount = filesToUse.reduce((sum, f) => sum + (f.lineCount || 0), 0);
      const contextSizeBytes = filteredContextToUse.length;
      
      const body =
        useIndexedSearch
          ? JSON.stringify({ 
              query: trimmed, 
              secretWord: normalizedSecretWord || undefined
            })
          : JSON.stringify({ 
              message: trimmed, 
              context: filteredContextToUse,
              totalFiles: totalFilesCount,
              filteredFiles: filteredFilesCount,
              contextSize: contextSizeBytes,
              totalLines: totalLinesCount
            });

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
      } finally {
        window.clearTimeout(timeoutId);
      }
      const data = (await response.json()) as {
        text?: string;
        error?: string;
        warning?: string;
        details?: string;
        sources?: Array<{ path: string; lineCount?: number; fileSize?: number }>;
        relevantChunks?: number;
        chunksUsedInPrompt?: number;
        filteredFiles?: number;
        totalFiles?: number;
      };
      
      // Handle data size warning (202 Accepted)
      if (response.status === 202 && data.warning) {
        chatOk = false;
        // Store pending request info for potential retry
        setPendingChatRequest({
          message: trimmed,
          contextText: filteredContextToUse,
          totalFiles: totalFilesCount,
          filteredFiles: filteredFilesCount,
          contextSize: contextSizeBytes
        });
        
        // Set warning dialog
        setDataWarning({
          visible: true,
          title: data.warning,
          details: data.details,
          filteredFiles: data.filteredFiles,
          totalFiles: data.totalFiles,
          onConfirm: async () => {
            // Resend request without size checks (would need backend flag to skip)
            // For now, just show message and let user retry when data is smaller
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                text: "Zmenšete prosím kontext (odfiltrujte méně souborů) a zkuste znovu. Nebo zkuste hledání přes Knowledge Base pokud máte data zaindexovaná.",
              },
            ]);
          }
        });
        setIsSending(false);
        return;
      }
      
      if (!response.ok) {
        throw new Error(data.error ?? "Request failed.");
      }

      if (Array.isArray(data.sources)) {
        setLastSearchSources(data.sources);
      }
      let processedText = data.text ?? "";
      
      // Extract chart
      const { cleanText: textAfterChart, chart } = extractChartBlock(processedText);
      if (chart) {
        setAssistantCharts((prev) => [
          ...prev,
          { ...chart, id: generateUUID() },
        ]);
      }
      processedText = textAfterChart;
      
      // Extract table
      const { cleanText: textAfterTable, table } = extractTableBlock(processedText);
      if (table) {
        setAssistantTables((prev) => [
          ...prev,
          { ...table, id: generateUUID() },
        ]);
      }
      processedText = textAfterTable;
      
      // Extract structured results
      const { cleanText: finalText, structured } = extractStructuredBlock(processedText);
      if (structured) {
        setStructuredResult(structured);
        setActiveTab("results");
      }
      
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: finalText || data.text || "" },
      ]);
    } catch (error) {
      chatOk = false;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text:
            error instanceof DOMException && error.name === "AbortError"
              ? didTimeout
                ? `Požadavek vypršel po ${Math.round(CHAT_REQUEST_TIMEOUT_MS / 1000)} s (timeout). Zkuste to prosím znovu; případně nejdřív zmenšete dotaz nebo přidejte méně souborů do kontextu.`
                : "Požadavek byl zrušen (abort)."
              : error instanceof Error
                ? error.message
                : "Request failed.",
        },
      ]);
    } finally {
      finalizeChatQuery(secretWord, historyId, chatOk);
      setIsSending(false);
    }
  };

  // Check if Samba section should be shown (default: true if not set or set to "1")
  const showSamba = process.env.NEXT_PUBLIC_SHOW_SAMBA !== "0";

  const assistantAllFiles = useMemo(() => {
    const seen = new Set<string>();
    const items: Array<{ path: string; description?: string; lineCount?: number; fileSize?: number }> = [];
    if (structuredResult) {
      for (const group of structuredResult.groups) {
        for (const f of group.files) {
          const p = String(f.path ?? "").trim();
          if (!p || seen.has(p)) continue;
          seen.add(p);
          items.push({ path: p, description: f.description });
        }
      }
      return items;
    }
    for (const src of lastSearchSources) {
      const p = String(src.path ?? "").trim();
      if (!p || seen.has(p)) continue;
      seen.add(p);
      items.push({ 
        path: p, 
        lineCount: src.lineCount, 
        fileSize: src.fileSize 
      });
    }
    return items;
  }, [structuredResult, lastSearchSources]);

  const sortedAssistantFiles = useMemo(() => {
    const items = [...assistantAllFiles];
    const dir = assistantFilesSortDesc ? -1 : 1;
    const compareString = (a: string, b: string) => a.localeCompare(b, "cs", { sensitivity: "base" });

    items.sort((a, b) => {
      if (assistantFilesSortBy === "path") {
        return dir * compareString(a.path, b.path);
      }
      if (assistantFilesSortBy === "description") {
        return dir * compareString(a.description ?? "", b.description ?? "");
      }
      if (assistantFilesSortBy === "lines") {
        return dir * ((a.lineCount ?? 0) - (b.lineCount ?? 0));
      }
      if (assistantFilesSortBy === "size") {
        return dir * ((a.fileSize ?? 0) - (b.fileSize ?? 0));
      }
      return 0;
    });
    return items;
  }, [assistantAllFiles, assistantFilesSortBy, assistantFilesSortDesc]);

  const assistantSelectedCount = useMemo(() => {
    if (assistantAllFiles.length === 0) return 0;
    let count = 0;
    for (const f of assistantAllFiles) {
      if (selectedPaths.has(f.path)) count += 1;
    }
    return count;
  }, [assistantAllFiles, selectedPaths]);

  const assistantAllSelected = useMemo(() => {
    return assistantAllFiles.length > 0 && assistantSelectedCount === assistantAllFiles.length;
  }, [assistantAllFiles.length, assistantSelectedCount]);

  const formatBytes = (bytes?: number) => {
    if (!bytes || bytes <= 0) return "-";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const toggleAssistantSort = (next: AssistantFileSortBy) => {
    if (assistantFilesSortBy === next) {
      setAssistantFilesSortDesc((prev) => !prev);
      return;
    }
    setAssistantFilesSortBy(next);
    setAssistantFilesSortDesc(false);
  };

  const handleDownloadSelectedAssistantFiles = async () => {
    const paths = assistantAllFiles.filter((f) => selectedPaths.has(f.path)).map((f) => f.path);
    if (paths.length === 0) return;
    setStatus(`Balím ${paths.length} souborů do ZIP...`);
    try {
      const res = await fetch("/api/download/zip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths, zipName: secretWord?.length >= 5 ? `oznacene-${secretWord}` : "oznacene" }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "ZIP download failed.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "oznacene.zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setStatus(`✓ Staženo: ${paths.length} souborů (ZIP).`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "ZIP download failed.");
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-10 px-6 py-12">
        <header className="flex flex-col gap-4 relative">
          {/* Theme toggle button */}
          {themeLoaded && (
          <button
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            suppressHydrationWarning
            className={`absolute top-0 right-0 p-2 rounded-lg transition shadow-md text-xl ${
              theme === 'light' 
                ? 'bg-slate-700 hover:bg-slate-600 text-yellow-300' 
                : 'bg-slate-800 hover:bg-slate-700 text-orange-400'
            }`}
            title={theme === 'light' ? 'Přepnout na tmavý režim' : 'Přepnout na světlý režim'}
          >
            {theme === 'light' ? '🌙' : '☀️'}
          </button>
          )}
          <p className="text-sm uppercase tracking-[0.3em] text-slate-400">
            {/* Jardovo hledání */}
            Jardovo hledání
          </p>
          <h1 className="text-3xl font-semibold sm:text-4xl">
            Hledaní s Jardovou asistencí
          </h1>
          <p className="max-w-2xl text-slate-300">
            Vyberte místní složku, vyhledejte soubory podle názvu nebo obsahu a odešlete
            vybraný obsah souboru  Jardovi.
          </p>
        </header>

        {/* Secret Word Input Section */}
        <section className="grid gap-4 rounded-3xl border border-emerald-700 bg-emerald-900/40 p-6">
          <div className="flex flex-col gap-3">
            <h3 className="text-lg font-semibold text-emerald-100">
              Přístupové slovo 🔐
            </h3>
            <p className="text-sm text-emerald-200">
              Zadejte min. 5 znaků. Bez slova nebudou ostatní funkcionalité dostupné.
            </p>
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-2 md:flex-row md:items-end">
                <div className="flex-1 relative">
                  <input
                    type={showSecretWord ? "text" : "password"}
                    placeholder="Zadejte přístupové slovo (min. 5 znaků)..."
                    list="secret-words-list"
                    autoComplete="off"
                    className={`w-full rounded-2xl border px-4 py-3 pr-12 text-sm bg-slate-950 text-slate-100 placeholder-slate-500 ${
                      secretWord.length > 0 && secretWord.length < 5
                        ? "border-red-600"
                        : secretWord.length >= 5
                          ? "border-emerald-600"
                          : "border-slate-700"
                    }`}
                    value={secretWord}
                    onChange={(e) => setSecretWord(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && secretWord.length >= 5) {
                        // Could trigger context check/creation
                      }
                    }}
                  />
                  <datalist id="secret-words-list">
                    {savedSecretWords
                      .filter((word) => word !== secretWord)
                      .map((word) => (
                        <option key={word} value={word} />
                      ))}
                  </datalist>
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 transition"
                    onClick={() => setShowSecretWord(!showSecretWord)}
                    title={showSecretWord ? "Skrýt slovo" : "Zobrazit slovo"}
                  >
                    {showSecretWord ? "👁️" : "👁️‍🗨️"}
                  </button>
                </div>
                {secretWord.length >= 5 && (
                  <div className="text-sm text-emerald-300 font-semibold">
                    ✓ Slovo je platné
                  </div>
                )}
              </div>

              {secretWord.length > 0 && secretWord.length < 5 && (
                <p className="text-sm text-red-300">
                  Slovo musí mít minimálně 5 znaků.
                </p>
              )}
              {secretWordCheckingStatus && (
                <p className="text-sm text-amber-300">{secretWordCheckingStatus}</p>
              )}
              
              {/* Saved Words Management */}
              {savedSecretWords.length > 0 && (
                <div className="rounded-2xl border border-slate-700 bg-slate-900/40 p-3">
                  <p className="text-xs text-slate-400 mb-2">Uložená slova (klikněte pro výběr, ✕ pro smazání):</p>
                  <div className="flex flex-wrap gap-2">
                    {savedSecretWords.map((word) => (
                      <div
                        key={word}
                        className={`group flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs transition ${
                          word === secretWord
                            ? "border-emerald-600 bg-emerald-900/30 text-emerald-200"
                            : "border-slate-700 bg-slate-800/50 text-slate-300 hover:border-slate-600 hover:bg-slate-800 cursor-pointer"
                        }`}
                      >
                        <button
                          type="button"
                          className="font-mono"
                          onClick={() => setSecretWord(word)}
                          disabled={word === secretWord}
                        >
                          {word}
                        </button>
                        {word !== secretWord && (
                          <button
                            type="button"
                            className="text-slate-500 hover:text-red-400 transition opacity-0 group-hover:opacity-100"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemoveSavedWord(word);
                            }}
                            title="Odstranit z historie"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Secret Word Settings Section */}
        {secretWord.length >= 5 && (
        <section className="grid gap-4 rounded-3xl border border-slate-700 bg-slate-900/60 p-6">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-slate-200">
              Nastavení pro "{secretWord}"
            </h3>
            <div className="flex items-center gap-2">
              <button
                className="rounded-2xl border border-slate-600 bg-slate-900/40 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-900/60 transition"
                onClick={() => applySecretWordToFilesForm(secretWord)}
                title="Předvyplní formulář Soubory (bez spuštění hledání)"
              >
                Soubory
              </button>
              <button
                className="rounded-2xl border border-slate-600 bg-slate-900/40 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-900/60 transition"
                onClick={() => applySecretWordToSambaForm(secretWord).catch((err) => setStatus(err instanceof Error ? err.message : "Failed"))}
                title="Načte soubory z Samby a automaticky je přidá do kontextu"
              >
                Samba
              </button>
              <button
                className="rounded-2xl border border-emerald-700 bg-emerald-900/20 px-4 py-2 text-sm font-semibold text-emerald-200 hover:bg-emerald-900/35 transition"
                onClick={handleSaveSecretWordContext}
                title="Uloží aktuální hodnoty z formulářů (Samba/Soubory) pro toto slovo"
              >
                💾 Uložit
              </button>
              <button
                className="rounded-2xl border border-red-600 bg-red-900/30 px-4 py-2 text-sm font-semibold text-red-200 hover:bg-red-900/50 transition disabled:opacity-50"
                onClick={handleDeleteSecretWord}
                disabled={isDeletingSecretWord}
              >
                {isDeletingSecretWord ? "Mažu..." : <>🗑️ Smazat slovo <strong>{secretWord}</strong> a data</>}
              </button>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-2">
              <label className="text-xs text-slate-400">Samba cesta (volitelné)</label>
              <input
                className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-2 text-sm text-slate-100"
                placeholder="/mnt/samba nebo //server/share"
                value={secretWordSettings.sambaPath}
                onChange={(e) => {
                  const next = e.target.value;
                  setSecretWordSettings((prev) => ({ ...prev, sambaPath: next }));
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs text-slate-400">Filtry přípon (čárkou oddělené)</label>
              <input
                className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-2 text-sm text-slate-100"
                placeholder="pdf, xlsx, docx"
                value={secretWordSettings.extensions.join(", ")}
                onChange={(e) =>
                  setSecretWordSettings((prev) => ({
                    ...prev,
                    extensions: e.target.value
                      .split(",")
                      .map((ext) => ext.trim())
                      .filter((ext) => ext.length > 0),
                  }))
                }
              />
            </div>
          </div>

          {/* Knowledge Base Status */}
          {knowledgeBase?.initialized && (
            <div className="rounded-2xl border border-emerald-700 bg-emerald-900/20 p-4">
              <h4 className="text-sm font-semibold text-emerald-200 mb-2">
                📚 Knowledge Base - Zaindexovaná data
              </h4>
              <div className="grid gap-2 md:grid-cols-4">
                <div className="text-xs">
                  <span className="text-slate-400">Soubory:</span>
                  <span className="ml-2 font-semibold text-emerald-300">{knowledgeBase.totalFiles}</span>
                </div>
                <div className="text-xs">
                  <span className="text-slate-400">Chunks:</span>
                  <span className="ml-2 font-semibold text-emerald-300">{knowledgeBase.totalChunks}</span>
                </div>
                <div className="text-xs">
                  <span className="text-slate-400">Dimenze:</span>
                  <span className="ml-2 font-semibold text-emerald-300">{knowledgeBase.embeddingDimension}D</span>
                </div>
                <div className="text-xs">
                  {knowledgeBase.lastIndexedAt && (
                    <>
                      <span className="text-slate-400">Poslední indexace:</span>
                      <span className="ml-2 font-semibold text-emerald-300">
                        {new Date(knowledgeBase.lastIndexedAt).toLocaleString()}
                      </span>
                    </>
                  )}
                </div>
              </div>
              {knowledgeBase.readyForSearch && (
                <p className="mt-2 text-xs text-emerald-400 font-medium">✓ Připraveno k vyhledávání</p>
              )}
            </div>
          )}

          {secretWordSettings.lastIndexedAt && (
            <p className="text-xs text-slate-500">
              Naposledy indexováno: {new Date(secretWordSettings.lastIndexedAt).toLocaleString()}
            </p>
          )}
        </section>
        )}

        {/* File Selection Section */}
        <section className="grid gap-6 rounded-3xl border-2 border-blue-800 bg-slate-900/80 p-6">
          <div className="flex items-center justify-between border-b border-blue-700 pb-4 mb-2">
            <h2 className="text-xl font-bold text-blue-200">📁 Výběr souborů</h2>
            {isSecretUnlocked && (
              <p className="text-xs text-slate-400">Pro slovo: <span className="font-mono text-blue-300">{normalizedSecretWord}</span></p>
            )}
          </div>
          <div className={`rounded-2xl border px-3 py-2 text-xs ${
            isSecretUnlocked
              ? "border-emerald-700 bg-emerald-900/20 text-emerald-200"
              : "border-amber-700 bg-amber-900/20 text-amber-200"
          }`}>
            {isSecretUnlocked
              ? "🔐 Chráněný režim odemčen: Samba + index + Knowledge Base jsou aktivní pro zadané slovo."
              : "📂 Lokální režim: dostupná je jen práce s vybranou složkou. Samba/KB/index se odemknou po zadání slova (min. 5 znaků)."}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              className="rounded-full bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-900"
              onClick={handlePickDirectory}
            >
              Vybrat složku
            </button>
            <input
              ref={directoryInputRef}
              type="file"
              multiple
              // @ts-expect-error - non-standard directory picking attribute
              webkitdirectory="true"
              className="hidden"
              onChange={handleDirectoryInputChange}
            />
            <div className="text-sm text-slate-300">
              {directoryName ? (
                <span>Vybraná složka: {directoryName}</span>
              ) : (
                <span>Žádná složka nebyla vybrána.</span>
              )}
            </div>
          </div>

          {showSamba && isSecretUnlocked && (
          <div className="flex flex-col gap-3 rounded-2xl border border-slate-700 bg-slate-900/40 p-4">
            <h3 className="text-sm font-semibold text-slate-200">
              Nebo připojte Samba sdílení (pro dataset 300 GB+)
            </h3>
            <div className="grid gap-2 md:grid-cols-[1fr_auto]">
              <input
                className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-2 text-sm text-slate-100 placeholder-slate-500"
                placeholder="Samba path (e.g., /mnt/samba or //server/share)"
                value={sambaPath}
                onChange={(e) => {
                  const next = e.target.value;
                  setSambaPath(next);
                  // Clear stale results when path differs from last scan
                  if (next.trim() !== lastScannedSambaPath) {
                    setSambaFiles([]);
                    setSambaStats(null);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && sambaPath.trim() && !isSambaScanning) {
                    handleSambaScan();
                  }
                }}
              />
              <button
                className={`rounded-2xl border px-4 py-2 text-sm font-semibold ${
                  sambaPath.trim() && sambaPath.trim() !== lastScannedSambaPath
                    ? "border-amber-600 bg-amber-900/30 text-amber-200 animate-pulse"
                    : "border-slate-700"
                }`}
                onClick={handleSambaScan}
                disabled={!sambaPath || isSambaScanning}
              >
                {isSambaScanning
                  ? "Prohledávání..."
                  : sambaPath.trim() && sambaPath.trim() !== lastScannedSambaPath
                    ? "⟳ Prohledat novou cestu"
                    : "Prohledat úložiště"}
              </button>
              {isSambaScanning && (
                <button
                  className="rounded-2xl border border-red-600 bg-red-900/30 px-4 py-2 text-sm font-semibold text-red-200 hover:bg-red-900/50 transition"
                  onClick={cancelSambaScan}
                >
                  ⊗ Zastavit
                </button>
              )}
            </div>
            {sambaSuggestedPaths.length > 0 && (
              <div className="mt-2 rounded-2xl border border-amber-700/50 bg-amber-900/20 p-3">
                <p className="text-xs text-amber-200 font-semibold mb-2">
                  Doporučené cesty (začínající na "{sambaPath.split('/').pop()}"):
                </p>
                <div className="flex flex-wrap gap-2">
                  {sambaSuggestedPaths.map((suggested) => (
                    <button
                      key={suggested.path}
                      className="rounded-xl border border-amber-600 bg-amber-900/40 px-3 py-1 text-xs text-amber-200 hover:bg-amber-900/60 transition"
                      onClick={async () => {
                        setSambaPath(suggested.path);
                        setSambaSuggestedPaths([]);
                        // Automaticky scanuj po výběru
                        setIsSambaScanning(true);
                        setStatus("Scanning Samba share...");
                        try {
                          const controller = new AbortController();
                          const timeoutId = setTimeout(
                            () => controller.abort(),
                            REQUEST_TIMEOUT_MS * 3
                          );
                          const response = await fetch("/api/samba", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              sambaPath: suggested.path,
                              recursive: true,
                              maxFiles: 5000,
                              nameFilter: sambaFilter.trim(),
                              maxDays: sambaMaxDays,
                            }),
                            signal: controller.signal,
                          });
                          clearTimeout(timeoutId);
                          const data = (await response.json()) as {
                            success?: boolean;
                            files?: SambaEntry[];
                            stats?: SambaStats;
                            error?: string;
                            suggestedPaths?: Array<{ path: string; name: string }>;
                          };
                          if (!response.ok && !data.suggestedPaths) {
                            throw new Error(data.error ?? "Samba scan failed.");
                          }
                          
                          if (data.suggestedPaths && data.suggestedPaths.length > 0) {
                            setSambaSuggestedPaths(data.suggestedPaths);
                            setStatus(data.error ?? "Nalezeny cesty s prefixem");
                            setSambaFiles([]);
                            setSambaStats(null);
                          } else {
                            const files = data.files ?? [];
                            setSambaFiles(files);
                            setSambaStats(data.stats ?? null);
                            setSambaSuggestedPaths([]);
                            setLastScannedSambaPath(suggested.path);
                            setStatus(
                              `✓ Nalezeno ${data.stats?.totalFiles} souborů (${data.stats?.totalSizeGB} GB)`
                            );
                          }
                        } catch (error) {
                          setStatus(
                            error instanceof Error ? error.message : "Chyba prohledávání  úložiště."
                          );
                          setSambaSuggestedPaths([]);
                        } finally {
                          setIsSambaScanning(false);
                        }
                      }}
                    >
                      {suggested.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {sambaStats && (
              <p className="text-xs text-slate-400">
                Nalezeno {sambaStats.totalFiles} souborů ({sambaStats.totalSizeGB}{" "}
                GB)
              </p>
            )}
            <div className="mt-1">
              <p className="text-[11px] text-slate-500 mb-1">
                Filtr: čárkou oddělené, <code className="bg-slate-800 px-1 rounded">!</code> = vyloučit, <code className="bg-slate-800 px-1 rounded">*</code> = vše. Př.: <code className="bg-slate-800 px-1 rounded">docx, !eon</code>
              </p>
              <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                <input
                  className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-2 text-sm text-slate-100 placeholder-slate-500"
                  placeholder="Název souboru: docx, smlouva, !eon"
                  value={sambaFilter}
                  onChange={(e) => {
                    const next = e.target.value;
                    setSambaFilter(next);
                  }}
                />
                <input
                  className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-2 text-sm text-slate-100 placeholder-slate-500"
                  placeholder="Obsah souboru: faktura, !zrušeno"
                  value={sambaContentFilter}
                  onChange={(e) => {
                    const next = e.target.value;
                    setSambaContentFilter(next);
                  }}
                />
                <div className="flex items-center gap-1 rounded-2xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-300">
                  <span className="whitespace-nowrap">Dny</span>
                  <input
                    type="number"
                    min={0}
                    className="w-16 rounded border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                    value={sambaMaxDays}
                    onChange={(e) => {
                      const next = Math.max(0, Number(e.target.value) || 0);
                      setSambaMaxDays(next);
                    }}
                    title="Změna za posledních X dní (0 = vše)"
                  />
                </div>
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={autoAddSamba}
                onChange={(event) => {
                  const next = event.target.checked;
                  setAutoAddSamba(next);
                }}
              />
              Po skenu automaticky přidat soubory do kontextu
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <span>Limit auto‑add</span>
              <input
                type="number"
                min={0}
                className="w-24 rounded border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                value={autoAddLimit}
                onChange={(event) => {
                  const next = Math.max(0, Number(event.target.value) || 0);
                  setAutoAddLimit(next);
                }}
              />
              <span className="text-slate-400">0 = vše</span>
            </label>
          </div>
          )}

          {/* Lokální soubory - tabulka */}
          {files.length > 0 && (
            <div className="flex flex-col gap-3 rounded-2xl border border-slate-700 bg-slate-900/40 p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-200">
                  Soubory ({displayedFiles.length})
                </h3>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleDownloadAllFiles}
                    disabled={displayedFiles.length === 0}
                    className="px-3 py-1 text-xs rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50 transition"
                  >
                    📥 Stáhnout vše
                  </button>
                  {displayedFiles.length > 0 && (
                    <button
                      onClick={() => {
                        if (selectLocalFilesAllChecked) {
                          setSelectedLocalFilePaths(new Set());
                          setSelectLocalFilesAllChecked(false);
                        } else {
                          setSelectedLocalFilePaths(new Set(displayedFiles.map((f) => f.path)));
                          setSelectLocalFilesAllChecked(true);
                        }
                      }}
                      className="px-2 py-1 text-xs rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 font-semibold transition"
                    >
                      {selectLocalFilesAllChecked ? "Zrušit výběr" : "Vybrat vše"}
                    </button>
                  )}
                </div>
              </div>
              
              {/* Filtr */}
              <input
                className="w-full text-xs rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-200 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none"
                placeholder="Filtr souborů (např. .xlsx, 2019)"
                value={fileFilter}
                onChange={(e) => setFileFilter(e.target.value)}
              />
              
              {/* Tabulka */}
              <div className="max-h-[60vh] overflow-auto border border-slate-700 rounded-lg">
                {displayedFiles.length === 0 ? (
                  <p className="text-slate-500 p-4 text-xs">Žádné soubory odpovídající filtru.</p>
                ) : (
                  <table className="w-full border-collapse bg-white text-slate-900 text-xs">
                    <thead className="sticky top-0 bg-slate-100 border-b-2 border-slate-300">
                      <tr>
                        <th className="text-center py-2 px-2 text-slate-700 font-semibold w-8 border border-slate-300">
                          ✓
                        </th>
                        <th 
                          className="text-left py-2 px-3 text-slate-700 font-semibold border border-slate-300 cursor-pointer hover:bg-slate-200 transition"
                          onClick={() => {
                            if (fileSortBy === "name") {
                              setFileSortDesc(!fileSortDesc);
                            } else {
                              setFileSortBy("name");
                              setFileSortDesc(false);
                            }
                          }}
                        >
                          Soubor {fileSortBy === "name" && (fileSortDesc ? "↓" : "↑")}
                        </th>
                        <th 
                          className="text-right py-2 px-3 text-slate-700 font-semibold w-24 border border-slate-300 cursor-pointer hover:bg-slate-200 transition"
                          onClick={() => {
                            if (fileSortBy === "size") {
                              setFileSortDesc(!fileSortDesc);
                            } else {
                              setFileSortBy("size");
                              setFileSortDesc(false);
                            }
                          }}
                        >
                          Velikost {fileSortBy === "size" && (fileSortDesc ? "↓" : "↑")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayedFiles.map((entry, idx) => (
                        <tr key={entry.path} className={idx % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                          <td className="text-center py-2 px-2 border border-slate-300">
                            <input
                              type="checkbox"
                              checked={selectedLocalFilePaths.has(entry.path)}
                              onChange={() => {
                                const next = new Set(selectedLocalFilePaths);
                                if (next.has(entry.path)) {
                                  next.delete(entry.path);
                                  setSelectLocalFilesAllChecked(false);
                                } else {
                                  next.add(entry.path);
                                }
                                setSelectedLocalFilePaths(next);
                              }}
                              className="cursor-pointer"
                            />
                          </td>
                          <td className="text-left py-2 px-3 border border-slate-300 text-slate-700 truncate" title={entry.path}>
                            {entry.path.split("/").pop() || entry.path}
                          </td>
                          <td className="text-right py-2 px-3 border border-slate-300 text-slate-700">
                            {entry.size ? (entry.size < 1024 ? `${entry.size}B` : entry.size < 1024*1024 ? `${(entry.size/1024).toFixed(1)}KB` : `${(entry.size/(1024*1024)).toFixed(1)}MB`) : "0B"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              
              {/* Tlačítko pro přidání do kontextu */}
              {(selectedLocalFilePaths.size > 0 || (isAddingToContext && addContextMode === "local")) && (
                <button
                  onClick={isAddingToContext && addContextMode === "local" ? handleAbortAddToContext : handleAddLocalFilesToContext}
                  className={`w-full px-4 py-2 text-sm font-semibold rounded-lg text-white transition ${
                    isAddingToContext && addContextMode === "local"
                      ? "bg-rose-600 hover:bg-rose-700"
                      : "bg-blue-600 hover:bg-blue-700"
                  }`}
                >
                  {isAddingToContext && addContextMode === "local"
                    ? "⏹ Přerušit přidávání"
                    : `+ Přidat ${selectedLocalFilePaths.size} ${selectedLocalFilePaths.size === 1 ? "soubor" : selectedLocalFilePaths.size < 5 ? "soubory" : "souborů"} do kontextu`}
                </button>
              )}
            </div>
          )}
        </section>

        {/* HLEDÁNÍ V SOUBORECH */}
        <section className="grid gap-4 rounded-3xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1 text-[11px] text-slate-500">
              <span>Syntaxe: čárkou, <code className="bg-slate-800 px-1 rounded">!</code> = vyloučit, <code className="bg-slate-800 px-1 rounded">*</code> = vše. Př.: <code className="bg-slate-800 px-1 rounded">*, !eon</code> nebo <code className="bg-slate-800 px-1 rounded">docx, smlouva, !archiv</code></span>
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto_auto_auto]">
              <input
                className="w-full rounded-2xl border border-slate-800 bg-slate-950 px-4 py-2 text-sm text-slate-100"
                placeholder="Název souboru: docx, smlouva, !eon ..."
                value={query}
                onChange={(event) => {
                  const next = event.target.value;
                  setQuery(next);
                }}
                onKeyDown={(event) => { if (event.key === "Enter") handleSearch(); }}
              />
              <input
                className="w-full rounded-2xl border border-slate-800 bg-slate-950 px-4 py-2 text-sm text-slate-100"
                placeholder="Obsah souboru: faktura, !zruseno ..."
                value={contentQuery}
                onChange={(event) => {
                  const next = event.target.value;
                  setContentQuery(next);
                }}
                onKeyDown={(event) => { if (event.key === "Enter") handleSearch(); }}
              />
              <div className="flex items-center gap-2 rounded-2xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-300">
                <span>OCR str.</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  className="w-16 rounded border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                  value={ocrMaxPages}
                  onChange={(event) => {
                    const next = Math.min(
                      50,
                      Math.max(1, Number(event.target.value) || 1)
                    );
                    setOcrMaxPages(next);
                  }}
                />
              </div>
              <div className="flex items-center gap-1 rounded-2xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-300">
                <span className="whitespace-nowrap">Dny</span>
                <input
                  type="number"
                  min={0}
                  className="w-16 rounded border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                  value={folderMaxDays}
                  onChange={(event) => {
                    const next = Math.max(0, Number(event.target.value) || 0);
                    setFolderMaxDays(next);
                  }}
                  title="Změna za posledních X dní (0 = vše)"
                />
              </div>
              <button
                className="rounded-2xl border border-slate-700 px-4 py-2 text-sm"
                onClick={handleSearch}
                disabled={(!files.length && !sambaFiles.length) || isSearching}
              >
                {isSearching ? "Hledám..." : "Hledat"}
              </button>
              <button
                onClick={() => {
                  const next = searchMode === "and" ? "or" : "and";
                  setSearchMode(next);
                }}
                className={`px-3 py-2 text-xs rounded-2xl font-semibold transition ${
                  searchMode === "and"
                    ? "bg-slate-700 text-slate-100"
                    : "bg-slate-800 text-slate-400"
                }`}
              >
                {searchMode === "and" ? "AND" : "OR"}
              </button>
            </div>
          </div>

          {status && <p className="text-sm text-slate-400">{status}</p>}
          {loadProgress && (
            <div className="rounded-2xl border border-slate-800 bg-slate-950 p-3">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>{loadProgress.label}</span>
                <span>{loadProgress.percent}%</span>
              </div>
              <div className="mt-2 h-2 w-full rounded-full bg-slate-800">
                <div
                  className="h-2 rounded-full bg-emerald-400 transition-all"
                  style={{ width: `${loadProgress.percent}%` }}
                />
              </div>
            </div>
          )}
          {syncProgress && (
            <div className="rounded-2xl border border-slate-800 bg-slate-950 p-3">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>{syncProgress.label}</span>
                <span>{syncProgress.percent}%</span>
              </div>
              <div className="mt-2 h-2 w-full rounded-full bg-slate-800">
                <div
                  className="h-2 rounded-full bg-blue-400 transition-all"
                  style={{ width: `${syncProgress.percent}%` }}
                />
              </div>
            </div>
          )}
          {indexProgress && (
            <div className="rounded-2xl border border-slate-800 bg-slate-950 p-3">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>{indexProgress.label}</span>
                <span>{indexProgress.percent}%</span>
              </div>
              <div className="mt-2 h-2 w-full rounded-full bg-slate-800">
                <div
                  className="h-2 rounded-full bg-amber-400 transition-all"
                  style={{ width: `${indexProgress.percent}%` }}
                />
              </div>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-[3fr_1fr]">
            {/* Levá strana 75% - Kontext, Výsledky, Síťové soubory */}
            <div className="flex flex-col gap-4">
              
              {/* KONTEXT TABULKA */}
              <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
                <h3 className="text-sm font-semibold text-slate-200">
                  Kontext ({fileContext.length})
                </h3>
                <p className="mt-1 text-xs text-slate-400">
                  {contextText.length} / {MAX_CONTEXT_CHARS} chars
                </p>
                {fileContext.length > 0 && (() => {
                  const totalLines = fileContext.reduce((sum, f) => sum + (f.lineCount || 0), 0);
                  const totalSize = fileContext.reduce((sum, f) => sum + (f.size || 0), 0);
                  const formatSize = (bytes: number) => {
                    if (bytes < 1024) return `${bytes} B`;
                    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
                    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
                    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
                  };
                  return (
                    <div className="mt-2 bg-slate-900/50 rounded-lg p-2 border border-slate-800">
                      <div className="text-[11px] text-slate-400 grid grid-cols-3 gap-2">
                        <div><span className="text-slate-500">Řádky:</span> <span className="text-emerald-400 font-semibold">{totalLines.toLocaleString('cs-CZ')}</span></div>
                        <div><span className="text-slate-500">Velikost:</span> <span className="text-emerald-400 font-semibold">{formatSize(totalSize)}</span></div>
                        <div><span className="text-slate-500">Průměr:</span> <span className="text-blue-400 font-semibold">{Math.round(totalSize / Math.max(fileContext.length, 1) / 1024)} KB</span></div>
                      </div>
                    </div>
                  );
                })()}
                <div className="mt-3">
                  <input
                    className="w-full rounded-2xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500"
                    placeholder="Filtrovat kontext podle cesty (např. export-2019-10)"
                    value={contextFilter}
                    onChange={(e) => setContextFilter(e.target.value)}
                  />
                  {filteredContext.length !== fileContext.length && (
                    <div className="mt-1 text-[11px] space-y-0.5">
                      <p className="text-slate-500">
                        Filtrováno: {filteredContext.length} / {fileContext.length}
                      </p>
                      {knowledgeBase?.readyForSearch && (
                        <p className="text-amber-400">
                          ⚠️ Aktivní filtr → pracuji s lokálním kontextem (bez indexu)
                        </p>
                      )}
                    </div>
                  )}
                </div>
                <div className="mt-3 max-h-[60vh] overflow-auto border border-slate-700 rounded-lg">
                  {fileContext.length === 0 && (
                    <p className="text-slate-500 p-4">Žádné soubory v kontextu.</p>
                  )}
                  {displayedContext.length > 0 && (
                    <table className="w-full border-collapse bg-white text-slate-900 text-xs">
                      <thead className="sticky top-0 bg-slate-100 border-b-2 border-slate-300">
                        <tr>
                          <th 
                            className="text-left py-2 px-3 text-slate-700 font-semibold border border-slate-300 cursor-pointer hover:bg-slate-200 transition"
                            onClick={() => {
                              if (contextSortBy === "name") {
                                setContextSortDesc(!contextSortDesc);
                              } else {
                                setContextSortBy("name");
                                setContextSortDesc(false);
                              }
                            }}
                            title="Klikni pro třídění"
                          >
                            Název souboru {contextSortBy === "name" && (contextSortDesc ? "↓" : "↑")}
                          </th>
                          <th 
                            className="text-right py-2 px-3 text-slate-700 font-semibold w-16 border border-slate-300 cursor-pointer hover:bg-slate-200 transition"
                            onClick={() => {
                              if (contextSortBy === "lines") {
                                setContextSortDesc(!contextSortDesc);
                              } else {
                                setContextSortBy("lines");
                                setContextSortDesc(false);
                              }
                            }}
                            title="Klikni pro třídění"
                          >
                            Řádky {contextSortBy === "lines" && (contextSortDesc ? "↓" : "↑")}
                          </th>
                          <th 
                            className="text-right py-2 px-3 text-slate-700 font-semibold w-20 border border-slate-300 cursor-pointer hover:bg-slate-200 transition"
                            onClick={() => {
                              if (contextSortBy === "size") {
                                setContextSortDesc(!contextSortDesc);
                              } else {
                                setContextSortBy("size");
                                setContextSortDesc(false);
                              }
                            }}
                            title="Klikni pro třídění"
                          >
                            Velikost {contextSortBy === "size" && (contextSortDesc ? "↓" : "↑")}
                          </th>
                          <th 
                            className="text-right py-2 px-3 text-slate-700 font-semibold w-36 border border-slate-300 cursor-pointer hover:bg-slate-200 transition"
                            onClick={() => {
                              if (contextSortBy === "modified") {
                                setContextSortDesc(!contextSortDesc);
                              } else {
                                setContextSortBy("modified");
                                setContextSortDesc(false);
                              }
                            }}
                            title="Klikni pro třídění"
                          >
                            Datum {contextSortBy === "modified" && (contextSortDesc ? "↓" : "↑")}
                          </th>
                          <th className="text-center py-2 px-3 text-slate-700 font-semibold w-12 border border-slate-300"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayedContext.map((item, idx) => (
                          <tr key={item.path} className={`border border-slate-300 hover:bg-slate-200 transition ${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50'}`}>
                            <td className="py-2 px-3 border border-slate-300">
                              <span className="text-slate-900 font-medium truncate block" title={item.path}>
                                {item.path.split('/').pop() || item.path}
                              </span>
                              <span className="text-[10px] text-slate-500 block truncate">{item.path}</span>
                            </td>
                            <td className="text-right py-2 px-3 text-slate-800 font-mono border border-slate-300">
                              {item.lineCount?.toLocaleString('cs-CZ') || '-'}
                            </td>
                            <td className="text-right py-2 px-3 text-slate-800 font-mono border border-slate-300">
                              {((item.size || 0) / 1024).toFixed(1)} KB
                            </td>
                            <td className="text-right py-2 px-3 text-slate-700 font-mono border border-slate-300">
                              {item.modified ? (() => {
                                const d = new Date(item.modified);
                                const yyyy = d.getFullYear();
                                const mm = String(d.getMonth() + 1).padStart(2, '0');
                                const dd = String(d.getDate()).padStart(2, '0');
                                const hh = String(d.getHours()).padStart(2, '0');
                                const min = String(d.getMinutes()).padStart(2, '0');
                                return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
                              })() : '-'}
                            </td>
                            <td className="text-center py-2 px-3 border border-slate-300">
                              <button
                                className="text-rose-600 hover:text-rose-700 font-bold transition text-sm"
                                onClick={() => handleRemoveContext(item.path)}
                                title="Odebrat"
                              >
                                ✕
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {fileContext.length > contextDisplayCount && (
                    <button
                      className="mt-2 w-full text-xs px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                      onClick={() => setContextDisplayCount(contextDisplayCount + 100)}
                    >
                      Load More ({displayedContext.length}/{fileContext.length})
                    </button>
                  )}
                </div>
              </div>

              {/* VÝSLEDKY */}
            <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-200">
                  Výsledky  ({results.length})
                </h2>
                {results.length > 0 && (
                  <button
                    className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                    onClick={handleSelectAll}
                  >
                    {selectAllChecked ? "Zrušit výběr všeho" : "Vybrat vše"}
                  </button>
                )}
              </div>
              <div className="mt-3 max-h-72 space-y-2 overflow-auto text-sm">
                {results.length === 0 && (

                  <p className="text-slate-500">Žádné výsledky.</p>
                )}
                {results.map((entry) => (
                  <label
                    key={entry.path}
                    className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2"
                  >
                    <input
                      type="checkbox"
                      checked={selectedPaths.has(entry.path)}
                      onChange={() => toggleSelected(entry.path)}
                      className="mt-1"
                    />
                    <div>
                      <p className="font-medium text-slate-100">
                        {entry.path}
                      </p>
                      <p className="text-xs text-slate-400">
                        {(entry.size / 1024).toFixed(1)} KB
                        {entry.modified && (
                          <span>
                            {" "}• {new Date(entry.modified).toLocaleString()}
                          </span>
                        )}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {(sambaFiles.length > 0 || sambaPath.trim()) && (
              <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-200">
                    Síťové soubory ({sambaFiles.filter((f) => f.type === "file").length})
                  </h2>
                  <div className="flex items-center gap-2">
                    {(sambaFilter || sambaContentFilter || sambaMaxDays > 0) && (
                      <button
                        className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                        onClick={() => { setSambaFilter(""); setSambaContentFilter(""); setSambaMaxDays(0); }}
                      >
                        Zrušit filtry
                      </button>
                    )}
                    {isAddingToContext && addContextMode === "samba" && (
                      <button
                        className="text-sm px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-semibold shadow-md transition"
                        onClick={handleAbortAddToContext}
                      >
                        ⏹ Stop
                      </button>
                    )}
                    {sambaFiles.filter((f) => f.type === "file").length > 0 && !(isAddingToContext && addContextMode === "samba") && (
                      <button
                        className="text-sm px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow-md transition"
                        onClick={handleAddAllSambaToContext}
                      >
                        + Add All
                      </button>
                    )}
                  </div>
                </div>
                {/* Filter for adding */}
                {sambaFiles.filter((f) => f.type === "file").length > 0 && (
                  <div className="mt-2 p-2 bg-slate-900/40 rounded-lg border border-slate-800">
                    <input
                      className="w-full text-xs rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-slate-200 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none"
                      placeholder="Filtr pro Add (např. .xlsx, 2019)"
                      value={sambaAddFilter}
                      onChange={(e) => setSambaAddFilter(e.target.value)}
                    />
                    {sambaAddFilter && (
                      <p className="mt-1 text-[10px] text-slate-500">
                        Filtr: přidá jen soubory obsahující "{sambaAddFilter}"
                      </p>
                    )}
                  </div>
                )}
                
                {/* Filter input for display */}
                {sambaFiles.filter((f) => f.type === "file").length > 0 && (
                  <div className="mt-2 p-2 bg-slate-900/40 rounded-lg border border-slate-800">
                    <input
                      className="w-full text-xs rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-slate-200 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none"
                      placeholder="Filtr zobrazení (např. .xlsx, 2019)"
                      value={sambaFilter}
                      onChange={(e) => setSambaFilter(e.target.value)}
                    />
                    {sambaFilter && (
                      <p className="mt-1 text-[10px] text-slate-500">
                        Zobrazuje soubory obsahující "{sambaFilter}"
                      </p>
                    )}
                  </div>
                )}
                
                {(() => {
                  const allFiles = sambaFiles.filter((f) => f.type === "file");
                  const hasContentFilterSamba = sambaContentFilter.trim().length > 0;
                  const hasAnyFilter = sambaFilter.trim().length > 0 || sambaMaxDays > 0;
                  
                  const filtered = filterSambaFiles(allFiles);
                  
                  const filterCount = hasAnyFilter ? filtered.length : allFiles.length;
                  
                  return (
                    <>
                      {(hasAnyFilter || hasContentFilterSamba) && (
                        <p className="mt-1 text-[11px] text-slate-500">
                          {"Filtr: "}{filterCount}{" / "}{allFiles.length}{" soubor\u016f"}
                          {sambaMaxDays > 0 && (
                            <span className="ml-2 text-amber-400">{`posledn\u00edch ${sambaMaxDays} dn\u00ed`}</span>
                          )}
                          {hasContentFilterSamba && (
                            <span className="ml-2 text-blue-400">{"+ filtr obsahu (aplikuje se p\u0159i p\u0159id\u00e1n\u00ed do kontextu)"}</span>
                          )}
                        </p>
                      )}
                      <div className="mt-3 max-h-[60vh] overflow-auto border border-slate-700 rounded-lg">
                        {filtered.length === 0 && allFiles.length > 0 && (
                          <p className="text-xs text-slate-500 p-4">Žádné soubory neodpovídají filtru.</p>
                        )}
                        {filtered.length === 0 && allFiles.length === 0 && (
                          <p className="text-xs text-slate-500 p-4">Klikněte "Prohledat úložiště" pro načtení souborů.</p>
                        )}
                        {displayedSambaFiles.length > 0 && (
                          <table className="w-full border-collapse bg-white text-slate-900 text-xs">
                            <thead className="sticky top-0 bg-slate-100 border-b-2 border-slate-300">
                              <tr>
                                <th 
                                  className="text-left py-2 px-3 text-slate-700 font-semibold border border-slate-300 cursor-pointer hover:bg-slate-200 transition"
                                  onClick={() => {
                                    if (sambaSortBy === "name") {
                                      setSambaSortDesc(!sambaSortDesc);
                                    } else {
                                      setSambaSortBy("name");
                                      setSambaSortDesc(false);
                                    }
                                  }}
                                  title="Klikni pro třídění"
                                >
                                  Název souboru {sambaSortBy === "name" && (sambaSortDesc ? "↓" : "↑")}
                                </th>
                                <th 
                                  className="text-right py-2 px-3 text-slate-700 font-semibold w-20 border border-slate-300 cursor-pointer hover:bg-slate-200 transition"
                                  onClick={() => {
                                    if (sambaSortBy === "size") {
                                      setSambaSortDesc(!sambaSortDesc);
                                    } else {
                                      setSambaSortBy("size");
                                      setSambaSortDesc(false);
                                    }
                                  }}
                                  title="Klikni pro třídění"
                                >
                                  Velikost {sambaSortBy === "size" && (sambaSortDesc ? "↓" : "↑")}
                                </th>
                                <th 
                                  className="text-right py-2 px-3 text-slate-700 font-semibold w-36 border border-slate-300 cursor-pointer hover:bg-slate-200 transition"
                                  onClick={() => {
                                    if (sambaSortBy === "modified") {
                                      setSambaSortDesc(!sambaSortDesc);
                                    } else {
                                      setSambaSortBy("modified");
                                      setSambaSortDesc(false);
                                    }
                                  }}
                                  title="Klikni pro třídění"
                                >
                                  Datum {sambaSortBy === "modified" && (sambaSortDesc ? "↓" : "↑")}
                                </th>
                                <th className="text-center py-2 px-3 text-slate-700 font-semibold w-12 border border-slate-300"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {displayedSambaFiles.map((file, idx) => (
                                <tr key={file.path} className={`border border-slate-300 hover:bg-slate-200 transition ${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50'}`}>
                                  <td className="py-2 px-3 border border-slate-300">
                                    <span className="text-slate-900 font-medium truncate block" title={file.path}>
                                      {file.name}
                                    </span>
                                    <span className="text-[10px] text-slate-500 block truncate">{file.path}</span>
                                  </td>
                                  <td className="text-right py-2 px-3 text-slate-800 font-mono border border-slate-300">
                                    {((file.size || 0) / 1024).toFixed(1)} KB
                                  </td>
                                  <td className="text-right py-2 px-3 text-slate-700 font-mono border border-slate-300">
                                    {file.modified ? (() => {
                                      const d = new Date(file.modified);
                                      const yyyy = d.getFullYear();
                                      const mm = String(d.getMonth() + 1).padStart(2, '0');
                                      const dd = String(d.getDate()).padStart(2, '0');
                                      const hh = String(d.getHours()).padStart(2, '0');
                                      const min = String(d.getMinutes()).padStart(2, '0');
                                      return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
                                    })() : '-'}
                                  </td>
                                  <td className="text-center py-2 px-3 border border-slate-300">
                                    <button
                                      className="text-emerald-600 hover:text-emerald-700 font-bold transition text-sm"
                                      onClick={() => handleAddSambaToContext(file.path)}
                                      title="Přidat do kontextu"
                                    >
                                      + Add
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {filtered.length > 200 && (
                          <p className="text-xs text-slate-500 mt-2">
                            {"... zobrazeno prvn\u00edch 200 z "}{filtered.length}
                          </p>
                        )}
                      </div>
                    </>
                  );
                })()}
              </div>
            )}

            </div>

            {/* Pravá strana 25% - Tlačítka */}
            <div className="flex flex-col gap-3">
              <button
                className="rounded-2xl bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-900"
                onClick={isAddingToContext && addContextMode === "results" ? handleAbortAddToContext : handleAddToContext}
                disabled={!(isAddingToContext && addContextMode === "results") && !results.length}
              >
                {isAddingToContext && addContextMode === "results"
                  ? "⏹ Přerušit přidávání"
                  : "Přidat vybrané soubory do kontextu"}
              </button>
              <div className="flex flex-col gap-2">
                <button
                  className={`w-full rounded-2xl px-4 py-2 text-sm font-semibold ${
                    isIndexed
                      ? "bg-blue-600 text-white hover:bg-blue-700"
                      : "bg-amber-600 text-white hover:bg-amber-700"
                  } disabled:opacity-60 transition shadow-md`}
                  onClick={handleIndexFiles}
                  disabled={!isSecretUnlocked || fileContext.length === 0 || isIndexing || isRebuilding}
                >
                  {isIndexing
                    ? "Indexování..."
                    : isIndexed
                      ? "✓ Indexováno"
                      : "Indexovat soubory do databáze "}
                </button>
                {isIndexing && (
                  <button
                    className="w-full rounded-2xl bg-rose-600 hover:bg-rose-700 px-4 py-2 text-sm font-semibold text-white transition shadow-md"
                    onClick={() => {
                      if (indexAbortRef.current) {
                        indexAbortRef.current.abort();
                      }
                    }}
                  >
                    ⏹ Stop
                  </button>
                )}
              </div>
              <button
                className="rounded-2xl border border-amber-500/60 px-4 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-500/10 disabled:opacity-60"
                onClick={() => handleRebuildIndex("truncate")}
                disabled={!isSecretUnlocked || isIndexing || isRebuilding}
                title="Vymaze obsah tabulky file_index bez zmeny schematu"
              >
                {isRebuilding ? "Cistim..." : "Vymazat index"}
              </button>
              <button
                className="rounded-2xl border border-rose-500/60 px-4 py-2 text-sm font-semibold text-rose-200 hover:bg-rose-500/10 disabled:opacity-60"
                onClick={() => handleRebuildIndex("drop")}
                disabled={!isSecretUnlocked || isIndexing || isRebuilding}
                title="Smaze tabulku file_index a bude nutne znovu indexovat"
              >
                {isRebuilding ? "Rebuild..." : "Rebuild index"}
              </button>
              <button
                className="rounded-2xl border border-slate-700 px-4 py-2 text-sm"
                onClick={() => {
                  setFileContext([]);
                  setIsIndexed(false);
                }}
                disabled={!fileContext.length}
              >
                Vymazat kontext
              </button>
            </div>
          </div>
        </section>

        <section className="grid gap-4 rounded-3xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="flex flex-wrap items-center gap-3 justify-between">
            <h2 className="text-lg font-semibold">Graf souborů</h2>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="rounded-2xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                value={chartSource}
                onChange={(event) =>
                  setChartSource(event.target.value as ChartSource)
                }
              >
                <option value="results">Výsledky</option>
                <option value="samba">Samba soubory</option>
              </select>
              <select
                className="rounded-2xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                value={chartType}
                onChange={(event) =>
                  setChartType(event.target.value as ChartType2D)
                }
              >
                <option value="pie">Koláčový</option>
                <option value="bar">Sloupcový</option>
                <option value="line">Liniový</option>
              </select>
            </div>
          </div>
          <ResultsChart
            title={
              chartSource === "results"
                ? "Rozdělení výsledků podle přípony"
                : "Rozdělení Samba souborů podle přípony"
            }
            labels={chartData.labels}
            series={chartData.series}
            chartType={chartType}
          />
        </section>

        {/* Grafy z asistenta */}
        {assistantCharts.length > 0 && (
          <section className="grid gap-4 rounded-3xl border border-slate-800 bg-slate-900/60 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">📈 Grafy z asistenta ({assistantCharts.length})</h2>
              <button
                className="text-xs px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-semibold transition"
                onClick={() => {
                  if (confirm("Smazat všechny grafy z asistenta?")) {
                    setAssistantCharts([]);
                  }
                }}
              >
                Vymazat grafy
              </button>
            </div>
            <div className="grid gap-4">
              {assistantCharts.map((chart) => (
                <div key={chart.id} className="rounded-2xl border border-slate-700 bg-slate-950/40 p-4">
                  <h3 className="text-sm font-semibold text-slate-200 mb-3">{chart.title}</h3>
                  {chart.type === "3d" ? (
                    <Plot3D
                      title=""
                      data={(chart as any).data}
                      xLabel={(chart as any).xLabel}
                      yLabel={(chart as any).yLabel}
                      zLabel={(chart as any).zLabel}
                      height={400}
                    />
                  ) : (
                    <ResultsChart
                      title=""
                      labels={(chart as any).labels}
                      series={(chart as any).series}
                      chartType={(chart as any).type}
                    />
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Tabulky */}
        {assistantTables.length > 0 && (
          <section className="grid gap-4 rounded-3xl border border-slate-800 bg-slate-900/60 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Tabulky</h2>
              <button
                className="text-xs px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-semibold transition"
                onClick={() => {
                  if (confirm("Smazat všechny tabulky?")) {
                    setAssistantTables([]);
                  }
                }}
              >
                Vymazat tabulky
              </button>
            </div>
            <div className="grid gap-4">
              {assistantTables.map((table) => (
                <DataTable
                  key={table.id}
                  title={table.title}
                  headers={table.headers}
                  rows={table.rows}
                  id={table.id}
                />
              ))}
            </div>
          </section>
        )}

        <section className="grid gap-4 rounded-3xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="flex flex-wrap items-center gap-3 justify-between">
            <h2 className="text-lg font-semibold">Gemini asistent</h2>
            <div className="flex gap-2">
              <button
                className={`px-4 py-2 rounded-xl text-sm font-semibold transition ${
                  activeTab === "chat"
                    ? "bg-emerald-400 text-slate-900"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
                onClick={() => setActiveTab("chat")}
              >
                Chat
              </button>
              <button
                className={`px-4 py-2 rounded-xl text-sm font-semibold transition ${
                  activeTab === "results"
                    ? "bg-emerald-400 text-slate-900"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
                onClick={() => setActiveTab("results")}
              >
                Strukturované výsledky
                {structuredResult && (
                  <span className="ml-2 bg-emerald-500 text-slate-900 rounded-full px-2 py-0.5 text-xs">
                    {structuredResult.groups.length}
                  </span>
                )}
              </button>
              <button
                className={`px-4 py-2 rounded-xl text-sm font-semibold transition ${
                  activeTab === "files"
                    ? "bg-emerald-400 text-slate-900"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
                onClick={() => setActiveTab("files")}
              >
                Soubory
                {assistantAllFiles.length > 0 && (
                  <span className="ml-2 bg-emerald-500 text-slate-900 rounded-full px-2 py-0.5 text-xs">
                    {assistantAllFiles.length}
                  </span>
                )}
              </button>
            </div>
          </div>

          {activeTab === "chat" && (
            <>
              {/* Status indikátor zdroje dat */}
              <div className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs ${
                !isSecretUnlocked
                  ? "bg-blue-500/10 border border-blue-500/30 text-blue-300"
                  : hasDbIndex
                  ? "bg-emerald-500/10 border border-emerald-500/30 text-emerald-300"
                  : fileContext.length > 0
                    ? "bg-blue-500/10 border border-blue-500/30 text-blue-300"
                    : "bg-amber-500/10 border border-amber-500/30 text-amber-300"
              }`}>
                <span className={`inline-block h-2 w-2 rounded-full ${
                  !isSecretUnlocked ? "bg-blue-400" : hasDbIndex ? "bg-emerald-400 animate-pulse" : fileContext.length > 0 ? "bg-blue-400" : "bg-amber-400"
                }`} />
                {!isSecretUnlocked ? (
                  <span>Lokální režim bez tajného slova — chat používá jen aktuálně načtený UI kontext.</span>
                ) : hasDbIndex ? (
                  <span>
                    ✓ DB index připraven — vyhledávání funguje okamžitě
                    {knowledgeBase && knowledgeBase.totalFiles > 0 && (
                      <span className="text-emerald-400/60 ml-1">
                        ({knowledgeBase.totalFiles} souborů, {knowledgeBase.totalChunks} chunks)
                      </span>
                    )}
                  </span>
                ) : fileContext.length > 0 ? (
                  <span>UI kontext: {fileContext.length} souborů — Gemini odpovídá z načtených dat</span>
                ) : (
                  <span>Žádný zdroj dat — vyberte kontext nebo připojte úložiště a indexujte</span>
                )}
              </div>

              <div className="max-h-96 space-y-4 overflow-auto rounded-2xl border border-slate-800 bg-slate-950 p-4">
                {messages.length === 0 && (
                  <p className="text-sm text-slate-500">
                    {hasDbIndex 
                      ? "Index je připraven. Ptejte se na cokoli \u2014 nap\u0159.: \u201EM\u00e1m klienta EON, co k tomu pat\u0159\u00ed?\u201C"
                      : "Zeptejte se Gemini n\u011bco pomoc\u00ed kontextu soubor\u016f v\u00fd\u0161e. Nap\u0159.: \u201EM\u00e1m klienta Colonnade a Helvetia, zkus mi dohledat co ke komu pat\u0159\u00ed\u201C"}
                  </p>
                )}
                {messages.map((message, index) => (
                  <div
                    key={`${message.role}-${index}`}
                    className={
                      message.role === "user"
                        ? "rounded-2xl bg-slate-800 px-4 py-3 text-sm cursor-pointer hover:bg-slate-700 transition"
                        : "rounded-2xl bg-emerald-500/10 px-4 py-3 text-sm cursor-pointer hover:bg-emerald-500/20 transition"
                    }
                    onDoubleClick={() => {
                      setChatInput(message.text);
                      chatInputRef.current?.focus();
                    }}
                    title="Dvojklik pro zkopírování do pole"
                  >
                    <p className="text-xs uppercase text-slate-400">
                      {message.role}
                    </p>
                    <p className="mt-2 whitespace-pre-wrap text-slate-100">
                      {message.text}
                    </p>
                  </div>
                ))}
              </div>
              <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
                <textarea
                  ref={chatInputRef}
                  className="min-h-[96px] w-full rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-100"
                  placeholder="Zeptejte se..."
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                />

                {chatSuggestions.length > 0 && (
                  <div className="md:col-span-3 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-slate-500">Našeptávač:</span>
                    {chatSuggestions.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800 transition"
                        onClick={() => {
                          setChatInput(item.q);
                          chatInputRef.current?.focus();
                        }}
                        title={item.ok ? "Dříve úspěšný dotaz" : "Dřívější dotaz"}
                      >
                        {item.q}
                      </button>
                    ))}
                  </div>
                )}
                
                <button
                  className="h-fit rounded-2xl bg-slate-100 px-5 py-3 text-sm font-semibold text-slate-900 disabled:opacity-60"
                  onClick={handleSend}
                  disabled={isSending}
                >
                  {isSending ? "Odesílám..." : "Odeslat"}
                </button>

                  <button
                    className={`h-fit rounded-2xl px-5 py-3 text-sm font-semibold transition disabled:opacity-60 ${
                      isRecording
                        ? "bg-rose-500 text-slate-100 animate-pulse"
                        : "bg-slate-700 text-slate-100 hover:bg-slate-600"
                    }`}
                    onClick={isRecording ? stopVoiceInput : startVoiceInput}
                    disabled={isSending}
                    title={
                      !voiceSupported
                        ? "Hlasove diktovani neni v tomto prohlizeci dostupne"
                        : isRecording
                          ? "Zastavit nahravani"
                          : "Mluvit (cs-CZ)"
                    }
                  >
                    {isRecording ? "⏹" : "🎤"}
                  </button>

              </div>
              <p className="text-xs text-slate-400">
                {!voiceSupported
                  ? "Hlasove diktovani neni v tomto prohlizeci dostupne."
                  : typeof window !== "undefined" && !window.isSecureContext
                    ? "Hlasove diktovani vyzaduje HTTPS nebo localhost."
                    : "Napište otázku"}
              </p>
            </>
          )}

          {activeTab === "results" && (
            <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
              {structuredResult ? (
                <div className="space-y-6">
                  {structuredResult.summary && (
                    <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-4">
                      <p className="text-sm text-emerald-100">{structuredResult.summary}</p>
                    </div>
                  )}
                  {structuredResult.groups.map((group, groupIdx) => (
                    <div key={groupIdx} className="space-y-3">
                      <h3 className="text-lg font-semibold text-emerald-400 flex items-center gap-2">
                        <span className="rounded-lg bg-emerald-500/20 px-3 py-1">
                          {group.client}
                        </span>
                        <span className="text-xs text-slate-400">
                          ({group.files.length} souborů)
                        </span>
                      </h3>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-slate-700">
                              <th className="text-left py-2 px-3 text-slate-300 font-medium">#</th>
                              <th className="text-left py-2 px-3 text-slate-300 font-medium">Soubor</th>
                              <th className="text-left py-2 px-3 text-slate-300 font-medium">Popis</th>
                              <th className="text-left py-2 px-3 text-slate-300 font-medium">Velikost</th>
                            </tr>
                          </thead>
                          <tbody>
                            {group.files.map((file, fileIdx) => (
                              <tr key={fileIdx} className="border-b border-slate-800 hover:bg-slate-900/50">
                                <td className="py-2 px-3 text-slate-400">{fileIdx + 1}</td>
                                <td className="py-2 px-3">
                                  <a
                                    className="text-emerald-400 hover:text-emerald-300 hover:underline text-left break-all"
                                    href={`/api/download?path=${encodeURIComponent(file.path)}`}
                                    onClick={() => {
                                      const found = files.find((f) => f.path === file.path) ||
                                        sambaFiles.find((f) => f.path === file.path);
                                      if (found) {
                                        setSelectedPaths(new Set([file.path]));
                                        setStatus(`Vybrán: ${file.path}`);
                                      }
                                    }}
                                    title="Stáhnout soubor"
                                  >
                                    {file.path.split("/").pop() || file.path}
                                  </a>
                                  <div className="text-xs text-slate-500 mt-1">
                                    {file.path}
                                  </div>
                                </td>
                                <td className="py-2 px-3 text-slate-300">
                                  {file.description || "-"}
                                </td>
                                <td className="py-2 px-3 text-slate-400">
                                  {file.size ? `${(file.size / 1024).toFixed(1)} KB` : "-"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                  <div className="flex gap-3 pt-4 border-t border-slate-700">
                    <button
                      className="rounded-xl bg-emerald-500 hover:bg-emerald-600 px-4 py-2 text-sm font-semibold text-slate-900 transition"
                      onClick={() => {
                        const allPaths = structuredResult.groups.flatMap(g => g.files.map(f => f.path));
                        setSelectedPaths(new Set(allPaths));
                        setStatus(`Vybráno ${allPaths.length} souborů`);
                      }}
                    >
                      Vybrat všechny soubory
                    </button>
                    <button
                      className="rounded-xl bg-slate-700 hover:bg-slate-600 px-4 py-2 text-sm font-semibold text-slate-100 transition"
                      onClick={() => setStructuredResult(null)}
                    >
                      Vymazat výsledky
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-500">
                  Zatím žádné strukturované výsledky. Zeptejte se v chatu například: 
                  "Mám klienta Colonnade a Helvetia, zkus mi dohledat co ke komu patří"
                </p>
              )}
            </div>
          )}

          {activeTab === "files" && (
            <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
              {assistantAllFiles.length > 0 ? (
                <div className="space-y-4">
                  {(() => {
                    const totalLineCount = assistantAllFiles.reduce((sum, f) => sum + (f.lineCount || 0), 0);
                    const totalFileSize = assistantAllFiles.reduce((sum, f) => sum + (f.fileSize || 0), 0);
                    const formatSize = (bytes?: number) => {
                      if (!bytes || bytes <= 0) return "0 B";
                      if (bytes < 1024) return `${bytes} B`;
                      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
                      if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
                      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
                    };

                    return (
                      <div className="bg-slate-900/50 rounded-lg p-3 border border-slate-800">
                        <div className="text-sm text-slate-300 grid grid-cols-2 gap-3 md:grid-cols-4">
                          <div>
                            <p className="text-slate-500 text-xs">Soubory</p>
                            <p className="font-semibold text-emerald-400">{assistantAllFiles.length}</p>
                          </div>
                          {totalLineCount > 0 && (
                            <div>
                              <p className="text-slate-500 text-xs">Řádky celkem</p>
                              <p className="font-semibold text-emerald-400">{totalLineCount.toLocaleString("cs-CZ")}</p>
                            </div>
                          )}
                          {totalFileSize > 0 && (
                            <div>
                              <p className="text-slate-500 text-xs">Velikost</p>
                              <p className="font-semibold text-emerald-400">{formatSize(totalFileSize)}</p>
                            </div>
                          )}
                          <div>
                            <p className="text-slate-500 text-xs">Zdroj</p>
                            <p className="font-semibold text-blue-400">
                              {structuredResult ? "Strukturované" : lastSearchSources.length > 0 ? "Vyhledávání" : "?"}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm text-slate-300">
                      Zobrazuji {assistantAllFiles.length} unikátních souborů
                      {structuredResult ? " (ze strukturovaných výsledků)" : lastSearchSources.length > 0 ? " (z posledního vyhledávání)" : ""}.
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        className="rounded-xl bg-emerald-500 hover:bg-emerald-600 px-4 py-2 text-sm font-semibold text-slate-900 transition"
                        onClick={() => {
                          const allPaths = assistantAllFiles.map((x) => x.path);
                          if (assistantAllSelected) {
                            setSelectedPaths(new Set());
                            setStatus("Výběr zrušen.");
                            return;
                          }
                          setSelectedPaths(new Set(allPaths));
                          setStatus(`Vybráno ${allPaths.length} souborů`);
                        }}
                      >
                        {assistantAllSelected ? "Zrušit výběr" : "Vybrat vše"}
                      </button>

                      {assistantSelectedCount > 0 && (
                        <button
                          className="rounded-xl bg-slate-100 hover:bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-900 transition"
                          onClick={handleDownloadSelectedAssistantFiles}
                          title="Zabalí označené soubory na serveru do ZIP a stáhne"
                        >
                          📦 Stáhnout označené ({assistantSelectedCount})
                        </button>
                      )}
                      {!structuredResult && lastSearchSources.length > 0 && (
                        <button
                          className="rounded-xl bg-slate-700 hover:bg-slate-600 px-4 py-2 text-sm font-semibold text-slate-100 transition"
                          onClick={() => setLastSearchSources([])}
                        >
                          Vymazat seznam
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="max-h-[60vh] overflow-auto rounded-2xl border border-slate-800">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 z-10 bg-slate-950">
                        <tr className="border-b border-slate-700">
                          <th className="text-left py-2 px-3 text-slate-300 font-medium w-[72px]">
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-slate-600 bg-slate-950"
                                checked={assistantAllSelected}
                                onChange={() => {
                                  const allPaths = assistantAllFiles.map((x) => x.path);
                                  if (assistantAllSelected) {
                                    setSelectedPaths(new Set());
                                  } else {
                                    setSelectedPaths(new Set(allPaths));
                                  }
                                }}
                                title={assistantAllSelected ? "Zrušit výběr" : "Vybrat vše"}
                              />
                              <button
                                type="button"
                                className="hover:underline"
                                onClick={() => toggleAssistantSort("path")}
                                title="Třídit"
                              >
                                #
                              </button>
                            </div>
                          </th>
                          <th className="text-left py-2 px-3 text-slate-300 font-medium">
                            <button
                              type="button"
                              className="hover:underline"
                              onClick={() => toggleAssistantSort("path")}
                              title="Třídit podle souboru"
                            >
                              Soubor
                            </button>
                          </th>
                          <th className="text-left py-2 px-3 text-slate-300 font-medium w-[120px]">
                            <button
                              type="button"
                              className="hover:underline"
                              onClick={() => toggleAssistantSort("lines")}
                              title="Třídit podle řádků"
                            >
                              Řádky
                            </button>
                          </th>
                          <th className="text-left py-2 px-3 text-slate-300 font-medium w-[140px]">
                            <button
                              type="button"
                              className="hover:underline"
                              onClick={() => toggleAssistantSort("size")}
                              title="Třídit podle velikosti"
                            >
                              Velikost
                            </button>
                          </th>
                          <th className="text-left py-2 px-3 text-slate-300 font-medium">
                            <button
                              type="button"
                              className="hover:underline"
                              onClick={() => toggleAssistantSort("description")}
                              title="Třídit podle popisu"
                            >
                              Popis
                            </button>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedAssistantFiles.map((file, idx) => (
                          <tr
                            key={`${file.path}-${idx}`}
                            className="border-b border-slate-800 hover:bg-slate-900/50"
                          >
                            <td className="py-2 px-3 text-slate-400 align-top">
                              <div className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4 rounded border-slate-600 bg-slate-950"
                                  checked={selectedPaths.has(file.path)}
                                  onChange={() => toggleSelected(file.path)}
                                  title="Označit"
                                />
                                <span className="tabular-nums">{idx + 1}</span>
                              </div>
                            </td>
                            <td className="py-2 px-3 align-top">
                              <a
                                className="text-emerald-400 hover:text-emerald-300 hover:underline text-left break-all"
                                href={`/api/download?path=${encodeURIComponent(file.path)}`}
                                title="Stáhnout soubor"
                              >
                                {file.path.split("/").pop() || file.path}
                              </a>
                              <div className="text-xs text-slate-500 mt-1 break-all">{file.path}</div>
                            </td>
                            <td className="py-2 px-3 text-slate-400 align-top">
                              {file.lineCount ? file.lineCount.toLocaleString("cs-CZ") : "-"}
                            </td>
                            <td className="py-2 px-3 text-slate-400 align-top">{formatBytes(file.fileSize)}</td>
                            <td className="py-2 px-3 text-slate-300 align-top">{file.description || "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-500">
                  Zatím tu nemám seznam souborů. Nejdřív získejte strukturované výsledky (záložka „Strukturované výsledky“),
                  nebo spusťte dotaz přes DB index (pak se sem uloží zdroje z posledního vyhledávání).
                </p>
              )}
            </div>
          )}
        </section>

        {/* Data size warning dialog */}
        {dataWarning.visible && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
            <div className="rounded-2xl border border-amber-700 bg-amber-950 p-6 max-w-md shadow-lg">
              <h2 className="text-lg font-semibold text-amber-200 mb-3">
                ⚠️ {dataWarning.title || "Velké množství dat"}
              </h2>
              <p className="text-sm text-amber-100 mb-4">
                {dataWarning.details || "Zpracování těchto dat může trvat déle."}
              </p>
              {dataWarning.filteredFiles !== undefined && dataWarning.totalFiles !== undefined && (
                <p className="text-xs text-amber-300 mb-4">
                  Filtrované: {dataWarning.filteredFiles} / {dataWarning.totalFiles} souborů
                </p>
              )}
              <div className="flex gap-3">
                <button
                  onClick={() => setDataWarning({ visible: false })}
                  className="flex-1 rounded-lg bg-slate-700 hover:bg-slate-600 px-4 py-2 text-sm font-medium text-slate-200 transition"
                >
                  Zrušit
                </button>
                <button
                  onClick={() => {
                    setDataWarning({ visible: false });
                    if (dataWarning.onConfirm) dataWarning.onConfirm();
                  }}
                  className="flex-1 rounded-lg bg-amber-600 hover:bg-amber-700 px-4 py-2 text-sm font-medium text-white transition"
                >
                  Pokračovat
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
