"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import ResultsChart from "../components/ResultsChart";

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
  modified?: string;
  created?: string;
};

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

type ChartType = "pie" | "bar" | "line";
type ChartSource = "results" | "samba";
type AssistantChart = {
  title: string;
  type: ChartType;
  labels: string[];
  series: number[];
};
type AssistantChartItem = AssistantChart & {
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
  sambaPath: string;
  autoSyncMinutes: number;
  extensions: string[];
  notifyOnSync: boolean;
  lastIndexedAt?: string;
  files: Record<string, SavedFileMeta>;
  uiPaths?: string[];
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
  chart: AssistantChart | null;
} {
  const blockRegex = /\[\[CHART\]\]([\s\S]*?)\[\[\/CHART\]\]/i;
  const match = text.match(blockRegex);
  if (!match) {
    return { cleanText: text, chart: null };
  }

  const raw = match[1].trim();
  let chart: AssistantChart | null = null;
  try {
    const parsed = JSON.parse(raw) as AssistantChart;
    if (
      parsed &&
      (parsed.type === "pie" || parsed.type === "bar") &&
      Array.isArray(parsed.labels) &&
      Array.isArray(parsed.series)
    ) {
      chart = parsed;
    }
  } catch {
    chart = null;
  }

  const cleanText = text.replace(blockRegex, "").trim();
  return { cleanText, chart };
}

export default function Home() {
  const [directoryName, setDirectoryName] = useState<string | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileEntry[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [fileContext, setFileContext] = useState<FileContext[]>([]);
  const [searchContent, setSearchContent] = useState(false);
  const [searchMode, setSearchMode] = useState<"and" | "or">("and"); // AND by default
  const [status, setStatus] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [isIndexed, setIsIndexed] = useState(false);
  const [selectAllChecked, setSelectAllChecked] = useState(false);
  const [sambaPath, setSambaPath] = useState<string>("");
  const [sambaFiles, setSambaFiles] = useState<SambaEntry[]>([]);
  const [isSambaScanning, setIsSambaScanning] = useState(false);
  const [sambaStats, setSambaStats] = useState<SambaStats | null>(null);
  const [autoAddSamba, setAutoAddSamba] = useState(false);
  const [autoAddLimit, setAutoAddLimit] = useState(0);
  const [sambaFilter, setSambaFilter] = useState("");
  const searchAbortRef = useRef<AbortController | null>(null);
  const directoryInputRef = useRef<HTMLInputElement | null>(null);
  const [chartType, setChartType] = useState<ChartType>("pie");
  const [chartSource, setChartSource] = useState<ChartSource>("results");
  const [assistantCharts, setAssistantCharts] = useState<AssistantChartItem[]>(
    []
  );
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

  const contextText = useMemo(() => buildContext(fileContext), [fileContext]);

  const filteredContext = useMemo(() => {
    const q = contextFilter.trim().toLowerCase();
    if (!q) return fileContext;
    return fileContext.filter((f) => f.path.toLowerCase().includes(q));
  }, [contextFilter, fileContext]);

  const CONTEXT_DISPLAY_LIMIT = 200;
  const displayedContext = useMemo(
    () => filteredContext.slice(0, CONTEXT_DISPLAY_LIMIT),
    [filteredContext]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(CONTEXTS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as SavedContext[];
      if (Array.isArray(parsed)) {
        setSavedContexts(parsed);
        if (parsed.length > 0) {
          setActiveContextId((prev) => prev ?? parsed[0].id);
        }
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

  const activeContext = useMemo(() => {
    if (!activeContextId) return null;
    return savedContexts.find((ctx) => ctx.id === activeContextId) ?? null;
  }, [activeContextId, savedContexts]);

  const hasDbIndex = useMemo(() => {
    return (
      isIndexed ||
      Boolean(activeContext?.lastIndexedAt) ||
      dbIndexStatus.hasAnyIndex ||
      dbIndexStatus.hasContextIndex ||
      Boolean(knowledgeBase?.initialized)
    );
  }, [
    isIndexed,
    activeContext?.lastIndexedAt,
    dbIndexStatus.hasAnyIndex,
    dbIndexStatus.hasContextIndex,
    knowledgeBase?.initialized,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
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
  }, [activeContext?.id]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;

    const loadKB = async () => {
      try {
        const res = await fetch("/api/knowledge-base/status");
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
  }, []);

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
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      setResults([]);
      return;
    }
    if (files.length === 0) {
      if (sambaFiles.length > 0) {
        setSambaFilter(trimmed);
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
    setStatus("Searching...");

    // Parse comma-separated terms (trim each, spaces inside terms are preserved)
    const terms = trimmed.split(",").map((t) => t.trim()).filter((t) => t.length > 0);

    const matches: FileEntry[] = [];
    for (let index = 0; index < files.length; index += 1) {
      if (controller.signal.aborted) {
        return;
      }
      const entry = files[index];
      const pathLower = entry.path.toLowerCase();
      let matched = false;

      if (searchMode === "and") {
        // All terms must match
        matched = true;
        for (const term of terms) {
          // Try matching term with optional dot prefix for extensions
          const variations = [term, `.${term}`];
          const pathMatch = variations.some((v) => pathLower.includes(v));
          
          if (!pathMatch && searchContent) {
            try {
              if (entry.size <= MAX_FILE_BYTES) {
                const text = await readFileText(
                  entry,
                  MAX_FILE_BYTES,
                  ocrMaxPages
                );
                if (!text.toLowerCase().includes(term)) {
                  matched = false;
                  break;
                }
              } else {
                matched = false;
                break;
              }
            } catch {
              matched = false;
              break;
            }
          } else if (!pathMatch) {
            matched = false;
            break;
          }
        }
      } else {
        // At least one term must match (OR)
        for (const term of terms) {
          const variations = [term, `.${term}`];
          const pathMatch = variations.some((v) => pathLower.includes(v));
          
          if (pathMatch) {
            matched = true;
            break;
          }
          if (searchContent) {
            try {
              if (entry.size <= MAX_FILE_BYTES) {
                const text = await readFileText(
                  entry,
                  MAX_FILE_BYTES,
                  ocrMaxPages
                );
                if (text.toLowerCase().includes(term)) {
                  matched = true;
                  break;
                }
              }
            } catch {
              // ignore
            }
          }
        }
      }

      if (matched) {
        matches.push(entry);
      }
      if ((index + 1) % SEARCH_BATCH_SIZE === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    setResults(matches);
    setStatus(
      `Found ${matches.length} matches. Mode: ${searchMode === "and" ? "AND (všechny termíny)" : "OR (libovolný termín)"}`
    );
    setIsSearching(false);
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
    if (!sambaPath.trim()) {
      setStatus("Enter a Samba path (e.g., /mnt/samba or //server/share)");
      return;
    }
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
          sambaPath: sambaPath.trim(),
          recursive: true,
          maxFiles: 5000,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
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
      setStatus(
        `✓ Nalezeno ${data.stats?.totalFiles} souborů (${data.stats?.totalSizeGB} GB)`
      );
      if (autoAddSamba) {
        await addSambaFilesToContext(files);
      }
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Chyba prohledávání  úložiště."
      );
    } finally {
      setIsSambaScanning(false);
    }
  };

  const handleAddSambaToContext = async (filePath: string) => {
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
      setFileContext((prev) => [
        ...prev,
        {
          path: filePath,
          content: data.text ?? "",
          size: data.textLength ?? 0,
        },
      ]);
      try {
        const text = (data.text ?? "").slice(0, MAX_FILE_BYTES);
        await cachePutText({
          path: filePath,
          text,
          size: text.length,
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
    let filesToAdd = files.filter(
      (f) =>
        f.type === "file" &&
        !fileContext.some((item) => item.path === f.path)
    );
    if (autoAddLimit > 0) {
      filesToAdd = filesToAdd.slice(0, autoAddLimit);
    }
    if (filesToAdd.length === 0) {
      setStatus("Všechny soubory jsou již v kontextu.");
      return;
    }
    setStatus(`Extrahuji ${filesToAdd.length} souborů...`);
    setLoadProgress({ label: "Start", percent: 0 });
    let added = 0;
    let failed = 0;
    let firstError: string | null = null;
    for (let index = 0; index < filesToAdd.length; index += 1) {
      const file = filesToAdd[index];
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
          setFileContext((prev) => [
            ...prev,
            {
              path: file.path,
              content: data.text ?? "",
              size: data.textLength ?? 0,
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
      } catch {
        // ignore individual file errors
        failed++;
      }
      const percent = Math.round(((index + 1) / filesToAdd.length) * 100);
      setLoadProgress({
        label: `${file.name} (${index + 1}/${filesToAdd.length})`,
        percent,
      });
    }
    setLoadProgress(null);
    if (added === 0 && failed > 0) {
      setStatus(
        firstError
          ? `Nepodařilo se přidat žádný soubor. ${firstError}`
          : "Nepodařilo se přidat žádný soubor. Zkontrolujte přístup k Samba cestě."
      );
      return;
    }
    setStatus(`✓ Added ${added} files to context. Neúspěšné: ${failed}`);
  };

  const handleAddAllSambaToContext = async () => {
    await addSambaFilesToContext(sambaFiles);
  };

  const handleAddToContext = async () => {
    if (selectedPaths.size === 0) {
      setStatus("Vyberte alespoň jeden soubor z výsledků.");
      return;
    }
    setStatus("Načítám vybrané soubory...");
    setLoadProgress({ label: "Start", percent: 0 });
    const selectedEntries = results.filter((entry) =>
      selectedPaths.has(entry.path)
    );
    const newContext: FileContext[] = [];
    for (let index = 0; index < selectedEntries.length; index += 1) {
      const entry = selectedEntries[index];
      if (fileContext.some((item) => item.path === entry.path)) {
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
        newContext.push({
          path: entry.path,
          content,
          size: entry.size,
          modified: entry.modified,
        });
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
    setStatus(`Added ${newContext.length} files to context.`);
  };

  const handleCreateContext = () => {
    const name = newContextName.trim();
    if (!name) {
      setStatus("Zadejte název kontextu.");
      return;
    }
    const context: SavedContext = {
      id: generateUUID(),
      name,
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
    if (!activeContext.sambaPath.trim()) {
      setStatus("Aktivní kontext nemá nastavenou Samba cestu.");
      return;
    }
    setStatus(`Synchronizuji kontext ${activeContext.name}...`);
    setSyncProgress({ label: "Start", percent: 0 });
    setIsSyncing(true);
    try {
      const sambaController = new AbortController();
      const sambaTimeoutId = window.setTimeout(
        () => sambaController.abort(),
        REQUEST_TIMEOUT_MS * 3
      );
      let response: Response;
      try {
        response = await fetch("/api/samba", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sambaPath: activeContext.sambaPath.trim(),
            recursive: true,
            maxFiles: 5000,
            maxDepth: 30,
            extensions: activeContext.extensions.length
              ? activeContext.extensions
              : undefined,
          }),
          signal: sambaController.signal,
        });
      } finally {
        window.clearTimeout(sambaTimeoutId);
      }
      const data = (await response.json()) as {
        files?: SambaEntry[];
        stats?: SambaStats;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "Samba scan failed.");
      }

      // Populate the Samba panel so the user sees immediate results.
      if (Array.isArray(data.files)) {
        setSambaFiles(data.files);
      }
      if (data.stats) {
        setSambaStats(data.stats);
      }
      const sambaFilesList = (data.files ?? []).filter(
        (file) => file.type === "file"
      );
      if (sambaFilesList.length === 0) {
        setStatus(
          "Samba scan doběhl, ale nebyl nalezen žádný soubor k indexaci. " +
            "Zkontrolujte přípony/filtr a jestli cesta neobsahuje jen adresáře."
        );
        setSyncProgress(null);
        return;
      }

      const updatedFiles = { ...activeContext.files };
      const filesToIndex: Array<{ name: string; content: string }> = [];

      let unchangedCount = 0;
      let extractedCount = 0;
      let skippedBadExtractCount = 0;

      for (let index = 0; index < sambaFilesList.length; index += 1) {
        const file = sambaFilesList[index];
        const meta = updatedFiles[file.path] ?? {};
        const sameModified =
          (meta.modified ?? "") === String(file.modified ?? "");
        const sameSize =
          Number(meta.size ?? -1) === Number(file.size ?? -2);
        const unchanged = sameModified && sameSize;
        if (unchanged) {
          unchangedCount += 1;
          continue;
        }
        setSyncProgress({
          label: `${file.name} (${index + 1}/${sambaFilesList.length})`,
          percent: Math.round(((index + 1) / sambaFilesList.length) * 100),
        });
        const extractController = new AbortController();
        const extractTimeoutId = window.setTimeout(
          () => extractController.abort(),
          REQUEST_TIMEOUT_MS * 2
        );
        let extractResponse: Response;
        try {
          extractResponse = await fetch("/api/extract", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              filePath: file.path,
              fileName: file.name,
            }),
            signal: extractController.signal,
          });
        } finally {
          window.clearTimeout(extractTimeoutId);
        }
        const extractData = (await extractResponse.json()) as {
          text?: string;
          error?: string;
        };
        if (!extractResponse.ok || !extractData.text) {
          skippedBadExtractCount += 1;
          continue;
        }
        extractedCount += 1;
        const hash = await computeHash(extractData.text);
        if (meta.hash && meta.hash === hash) {
          updatedFiles[file.path] = {
            modified: file.modified,
            created: file.created,
            size: file.size,
            hash,
          };
          continue;
        }
        filesToIndex.push({
          name: `${activeContext.id}:${file.path}`,
          content: extractData.text,
        });
        updatedFiles[file.path] = {
          modified: file.modified,
          created: file.created,
          size: file.size,
          hash,
        };
      }

      if (filesToIndex.length === 0) {
        setStatus(
          `Žádné změny k indexaci. (přeskočeno beze změny: ${unchangedCount}, extrahováno: ${extractedCount}, selhalo extrahování: ${skippedBadExtractCount})`
        );
        setSyncProgress(null);
        handleUpdateActiveContext({
          lastIndexedAt: new Date().toISOString(),
          files: updatedFiles,
        });
        setIsIndexed(true);
        return;
      }

      const indexController = new AbortController();
      const indexTimeoutId = window.setTimeout(
        () => indexController.abort(),
        REQUEST_TIMEOUT_MS * 4
      );
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
        skippedFiles?: Array<{ name: string; reason: string }>;
        skippedEmptyChunks?: number;
        embeddingDimension?: number;
      };
      if (!indexResponse.ok) {
        throw new Error(indexData.error ?? "Indexing failed.");
      }

      handleUpdateActiveContext({
        lastIndexedAt: new Date().toISOString(),
        files: updatedFiles,
      });
      setIsIndexed(true);
      const skippedCount = indexData.skippedFiles?.length ?? 0;
      const skippedHint = skippedCount
        ? ` (přeskočeno ${skippedCount} souborů; typicky prázdný/nevytěžený obsah)`
        : "";
      setStatus(`✓ Kontext ${activeContext.name} synchronizován.${skippedHint}`);
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

      batch.push({ path, content: text, size: text.length });
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
    if (fileContext.length === 0) {
      setStatus("Add files to context first.");
      return;
    }
    setIsIndexing(true);
    setStatus("Indexing files...");
    setIndexProgress({ label: "Příprava", percent: 0 });
    try {
      const filesPayload = fileContext.map((f, index) => {
        const percent = Math.round(((index + 1) / fileContext.length) * 50);
        setIndexProgress({
          label: `Příprava ${index + 1}/${fileContext.length}`,
          percent,
        });
        return {
          name: f.path,
          content: f.content,
        };
      });
      const controller = new AbortController();
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
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Indexing failed."
      );
    } finally {
      setIsIndexing(false);
      setTimeout(() => setIndexProgress(null), 800);
    }
  };

  const handleRebuildIndex = async (mode: "drop" | "truncate") => {
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
    let didTimeout = false;
    try {
      const asksWhatDataWeHave =
        /(s\s*jak(ymi|ými)\s*daty|jak(a|á)\s*data|co\s*m(a|á)me\s*k\s*dispozici|co\s*je\s*v\s*kontextu)/i.test(
          trimmed
        );

      if (asksWhatDataWeHave && fileContext.length === 0 && hasDbIndex) {
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
              contextId: activeContext?.id ?? undefined,
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
              contextId: activeContext?.id ?? undefined,
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

        // If we have file context, inform user to use DB for full analysis
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text:
              "Pro analýzu objednávek po státech z lokálního kontextu ještě není implementováno. Použijte synchronizovaný kontext v databázi pro analýzu všech souborů.",
          },
        ]);
        return;
      }

      // Local utility: counting string occurrences across currently loaded file contents.
      // This avoids model hallucinations and works even when context is truncated.
      const isCountRequest =
        /\bkolik\b/i.test(trimmed) &&
        /soubor/i.test(trimmed);
      if (isCountRequest) {
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

      // Use indexed search if available, otherwise fall back to direct gemini
      const endpoint = hasDbIndex ? "/api/search" : "/api/gemini";
      const body =
        hasDbIndex
          ? JSON.stringify({ query: trimmed })
          : JSON.stringify({ message: trimmed, context: contextText });

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
      const data = (await response.json()) as { text?: string; error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "Request failed.");
      }
      const { cleanText, chart } = extractChartBlock(data.text ?? "");
      if (chart) {
        setAssistantCharts((prev) => [
          ...prev,
          { ...chart, id: generateUUID() },
        ]);
      }
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: cleanText || data.text || "" },
      ]);
    } catch (error) {
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
      setIsSending(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-12">
        <header className="flex flex-col gap-4">
          <p className="text-sm uppercase tracking-[0.3em] text-slate-400">
            Gemini + Hledaní souborů
          </p>
          <h1 className="text-3xl font-semibold sm:text-4xl">
            Hledaní s Gemini asistencí
          </h1>
          <p className="max-w-2xl text-slate-300">
            Vyberte místní složku, vyhledejte soubory podle názvu nebo obsahu a odešlete
            vybraný obsah souboru do Gemini.
          </p>
        </header>

        <section className="grid gap-6 rounded-3xl border border-slate-800 bg-slate-900/60 p-6">
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

          <div className="flex flex-col gap-3 rounded-2xl border border-slate-700 bg-slate-900/40 p-4">
            <h3 className="text-sm font-semibold text-slate-200">
              Nebo připojte Samba sdílení (pro dataset 300 GB+)
            </h3>
            <div className="grid gap-2 md:grid-cols-[1fr_auto]">
              <input
                className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-2 text-sm text-slate-100 placeholder-slate-500"
                placeholder="Samba path (e.g., /mnt/samba or //server/share)"
                value={sambaPath}
                onChange={(e) => setSambaPath(e.target.value)}
              />
              <button
                className="rounded-2xl border border-slate-700 px-4 py-2 text-sm font-semibold"
                onClick={handleSambaScan}
                disabled={!sambaPath || isSambaScanning}
              >
                {isSambaScanning ? "Prohledávání..." : "Prohledat úložiště"}
              </button>
            </div>
            {sambaStats && (
              <p className="text-xs text-slate-400">
                Nalezeno {sambaStats.totalFiles} souborů ({sambaStats.totalSizeGB}{" "}
                GB)
              </p>
            )}
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={autoAddSamba}
                onChange={(event) => setAutoAddSamba(event.target.checked)}
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
                onChange={(event) =>
                  setAutoAddLimit(Math.max(0, Number(event.target.value) || 0))
                }
              />
              <span className="text-slate-400">0 = vše</span>
            </label>
          </div>
          <div className="flex flex-col gap-3 rounded-2xl border border-slate-700 bg-slate-900/40 p-4">
            <h3 className="text-sm font-semibold text-slate-200">
              Uložené kontexty (automatická indexace)
            </h3>
            <div className="grid gap-2 md:grid-cols-[1fr_auto_auto]">
              <input
                className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-2 text-sm text-slate-100 placeholder-slate-500"
                placeholder="Název nového kontextu (např. Vyplaty)"
                value={newContextName}
                onChange={(event) => setNewContextName(event.target.value)}
              />
              <input
                className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-2 text-sm text-slate-100 placeholder-slate-500"
                placeholder="Samba path pro kontext"
                value={newContextSambaPath}
                onChange={(event) => setNewContextSambaPath(event.target.value)}
              />
              <button
                className="rounded-2xl border border-slate-700 px-4 py-2 text-sm font-semibold"
                onClick={handleCreateContext}
              >
                Přidat
              </button>
            </div>
            {savedContexts.length > 0 ? (
              <div className="grid gap-2 md:grid-cols-[1fr_auto_auto]">
                <select
                  className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-2 text-sm text-slate-100"
                  value={activeContextId ?? ""}
                  onChange={(event) =>
                    setActiveContextId(event.target.value || null)
                  }
                >
                  {savedContexts.map((ctx) => (
                    <option key={ctx.id} value={ctx.id}>
                      {ctx.name}
                    </option>
                  ))}
                </select>
                <input
                  className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-2 text-sm text-slate-100"
                  placeholder="Samba path"
                  value={activeContext?.sambaPath ?? ""}
                  onChange={(event) =>
                    handleUpdateActiveContext({
                      sambaPath: event.target.value,
                    })
                  }
                />
                <button
                  className="rounded-2xl border border-slate-700 px-4 py-2 text-sm"
                  type="button"
                  onClick={handleSyncActiveContext}
                  disabled={!activeContext || isSyncing}
                >
                  {isSyncing ? "Syncing..." : "Sync now"}
                </button>
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                Zatím nemáte uložený kontext.
              </p>
            )}
            {activeContext && (
              <div className="grid gap-2 md:grid-cols-[1fr_auto_auto_auto]">
                <input
                  className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-2 text-sm text-slate-100"
                  placeholder="Přejmenovat kontext"
                  value={activeContext.name}
                  onChange={(event) =>
                    handleUpdateActiveContext({ name: event.target.value })
                  }
                />
                <input
                  className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-2 text-sm text-slate-100"
                  placeholder="Filtr přípon (např. pdf, xlsx)"
                  value={activeContext.extensions.join(", ")}
                  onChange={(event) =>
                    handleUpdateActiveContext({
                      extensions: event.target.value
                        .split(",")
                        .map((ext) => ext.trim())
                        .filter((ext) => ext.length > 0),
                    })
                  }
                />
                <div className="flex items-center gap-2 rounded-2xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-300">
                  <span>Auto sync (min)</span>
                  <input
                    type="number"
                    min={0}
                    max={1440}
                    className="w-20 rounded border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                    value={activeContext.autoSyncMinutes}
                    onChange={(event) =>
                      handleUpdateActiveContext({
                        autoSyncMinutes: Math.max(
                          0,
                          Number(event.target.value) || 0
                        ),
                      })
                    }
                  />
                </div>
              </div>
            )}
            {activeContext && (
              <div className="grid gap-2 md:grid-cols-[auto_auto_auto_1fr] items-center">
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={activeContext.notifyOnSync}
                    onChange={(event) =>
                      handleUpdateActiveContext({
                        notifyOnSync: event.target.checked,
                      })
                    }
                  />
                  Notifikace po syncu
                </label>
                <button
                  className="rounded-2xl border border-slate-700 px-3 py-2 text-xs"
                  onClick={handleEnableNotifications}
                >
                  Povolit notifikace
                </button>
                <button
                  className="rounded-2xl border border-slate-700 px-4 py-2 text-sm text-rose-300"
                  onClick={handleDeleteActiveContext}
                >
                  Smazat
                </button>
                <div className="flex flex-wrap items-center gap-2 justify-end">
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <span>Load limit</span>
                    <input
                      type="number"
                      min={1}
                      max={5000}
                      className="w-24 rounded border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                      value={uiLoadLimit}
                      onChange={(e) =>
                        setUiLoadLimit(Math.max(1, Number(e.target.value) || 1))
                      }
                    />
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input
                      type="checkbox"
                      checked={uiLoadCacheOnly}
                      onChange={(e) => setUiLoadCacheOnly(e.target.checked)}
                    />
                    Jen z cache
                  </label>
                  <button
                    className="rounded-2xl border border-slate-700 px-3 py-2 text-xs"
                    type="button"
                    onClick={handleSaveUiContextToActiveContext}
                    disabled={!activeContext}
                    title="Uloží seznam aktuálních souborů v UI kontextu do vybraného uloženého kontextu (jen cesty)."
                  >
                    Uložit UI kontext
                  </button>
                  <button
                    className="rounded-2xl border border-slate-700 px-3 py-2 text-xs"
                    type="button"
                    onClick={handleLoadUiContextFromActiveContext}
                    disabled={!activeContext}
                    title="Načte soubory do UI kontextu. Primárně z IndexedDB cache; volitelně umí doextrahovat chybějící."
                  >
                    Načíst do UI kontextu
                  </button>
                </div>
                <div className="text-xs text-slate-500">
                  {activeContext.lastIndexedAt
                    ? `Naposledy: ${new Date(
                        activeContext.lastIndexedAt
                      ).toLocaleString()}`
                    : "Zatím neindexováno"}
                </div>
              </div>
            )}
          </div>
          <div className="grid gap-3 md:grid-cols-[1fr_auto_auto_auto]">
            <input
              className="w-full rounded-2xl border border-slate-800 bg-slate-950 px-4 py-2 text-sm text-slate-100"
              placeholder="Hledat soubory (oddělené čárkou: xlsx, sick leave)..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="flex items-center gap-2 rounded-2xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-300">
              <span>OCR str.</span>
              <input
                type="number"
                min={1}
                max={50}
                className="w-16 rounded border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                value={ocrMaxPages}
                onChange={(event) =>
                  setOcrMaxPages(
                    Math.min(50, Math.max(1, Number(event.target.value) || 1))
                  )
                }
              />
            </div>
            <button
              className="rounded-2xl border border-slate-700 px-4 py-2 text-sm"
              onClick={handleSearch}
              disabled={!files.length || isSearching}
            >
              {isSearching ? "Hledání..." : "Hledat"}
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSearchMode(searchMode === "and" ? "or" : "and")}
                className={`px-3 py-1 text-xs rounded-full font-semibold transition ${
                  searchMode === "and"
                    ? "bg-slate-700 text-slate-100"
                    : "bg-slate-800 text-slate-400"
                }`}
              >
                {searchMode === "and" ? "AND" : "OR"}
              </button>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={searchContent}
                onChange={(event) => setSearchContent(event.target.checked)}
              />
              V obsahu
            </label>
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

          <div className="grid gap-4 md:grid-cols-[1fr_auto]">
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

            {sambaFiles.length > 0 && (
              <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-200">
                    Síťové soubory ({sambaFiles.filter((f) => f.type === "file").length})
                  </h2>
                  {sambaFilter && (
                    <button
                      className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                      onClick={() => setSambaFilter("")}
                    >
                      Zrušit filtr
                    </button>
                  )}
                  {sambaFiles.filter((f) => f.type === "file").length > 0 && (
                    <button
                      className="text-xs px-2 py-1 rounded bg-emerald-900 hover:bg-emerald-800 text-emerald-200"
                      onClick={handleAddAllSambaToContext}
                    >
                      + Add All
                    </button>
                  )}
                </div>
                <div className="mt-3 max-h-72 space-y-2 overflow-auto text-sm">
                  {sambaFiles
                    .filter((f) => f.type === "file")
                    .filter((f) =>
                      sambaFilter
                        ? String(f.name ?? f.path)
                            .toLowerCase()
                            .includes(sambaFilter)
                        : true
                    )
                    .slice(0, 100)
                    .map((file) => (
                      <button
                        key={file.path}
                        className="w-full text-left flex items-start justify-between gap-2 rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2 hover:bg-slate-900/60 transition"
                        onClick={() => handleAddSambaToContext(file.path)}
                      >
                        <div>
                          <p className="font-medium text-slate-100">
                            {file.name}
                          </p>
                          <p className="text-xs text-slate-400">
                            {(file.size / 1024).toFixed(1)} KB
                            {file.modified && (
                              <span>
                                {" "}• {new Date(file.modified).toLocaleString()}
                              </span>
                            )}
                            {file.created && (
                              <span>
                                {" "}• vytvořeno {new Date(
                                  file.created
                                ).toLocaleString()}
                              </span>
                            )}
                          </p>
                        </div>
                        <span className="text-xs text-emerald-400">+ Add</span>
                      </button>
                    ))}
                  {sambaFiles.filter((f) => f.type === "file").length > 100 && (
                    <p className="text-xs text-slate-500">
                      ... showing first 100 files
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-3">
              <button
                className="rounded-2xl bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-900"
                onClick={handleAddToContext}
                disabled={!results.length}
              >
                Přidat vybrané soubory do kontextu
              </button>
              <button
                className={`rounded-2xl px-4 py-2 text-sm font-semibold ${
                  isIndexed
                    ? "bg-blue-500 text-white"
                    : "bg-amber-500 text-slate-900"
                } disabled:opacity-60`}
                onClick={handleIndexFiles}
                disabled={fileContext.length === 0 || isIndexing || isRebuilding}
              >
                {isIndexing
                  ? "Indexování..."
                  : isIndexed
                    ? "✓ Indexováno"
                    : "Indexovat soubory do databáze "}
              </button>
              <button
                className="rounded-2xl border border-amber-500/60 px-4 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-500/10 disabled:opacity-60"
                onClick={() => handleRebuildIndex("truncate")}
                disabled={isIndexing || isRebuilding}
                title="Vymaze obsah tabulky file_index bez zmeny schematu"
              >
                {isRebuilding ? "Cistim..." : "Vymazat index"}
              </button>
              <button
                className="rounded-2xl border border-rose-500/60 px-4 py-2 text-sm font-semibold text-rose-200 hover:bg-rose-500/10 disabled:opacity-60"
                onClick={() => handleRebuildIndex("drop")}
                disabled={isIndexing || isRebuilding}
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

              {knowledgeBase?.initialized && (
                <div className="rounded-2xl border border-slate-700 bg-slate-900/50 p-4">
                  <h3 className="text-sm font-semibold text-slate-200">
                    Knowledge Base
                  </h3>
                  <div className="mt-2 space-y-1 text-xs text-slate-400">
                    <p>
                      <span className="font-medium">Soubory:</span>{" "}
                      {knowledgeBase.totalFiles}
                    </p>
                    <p>
                      <span className="font-medium">Chunks:</span>{" "}
                      {knowledgeBase.totalChunks}
                    </p>
                    <p>
                      <span className="font-medium">Dimenze:</span>{" "}
                      {knowledgeBase.embeddingDimension}D
                    </p>
                    {knowledgeBase.lastIndexedAt && (
                      <p>
                        <span className="font-medium">Poslední indexace:</span>{" "}
                        {new Date(knowledgeBase.lastIndexedAt).toLocaleString()}
                      </p>
                    )}
                    {knowledgeBase.readyForSearch && (
                      <p className="text-emerald-400 font-medium">Pripraveno k vyhledavani</p>
                    )}
                  </div>
                </div>
              )}

              <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
                <h3 className="text-sm font-semibold text-slate-200">
                  Kontext ({fileContext.length})
                </h3>
                <p className="mt-1 text-xs text-slate-400">
                  {contextText.length} / {MAX_CONTEXT_CHARS} chars
                </p>
                <div className="mt-3">
                  <input
                    className="w-full rounded-2xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500"
                    placeholder="Filtrovat kontext podle cesty (např. export-2019-10)"
                    value={contextFilter}
                    onChange={(e) => setContextFilter(e.target.value)}
                  />
                  {filteredContext.length !== fileContext.length && (
                    <p className="mt-1 text-[11px] text-slate-500">
                      Filtrováno: {filteredContext.length} / {fileContext.length}
                    </p>
                  )}
                </div>
                <div className="mt-3 max-h-56 space-y-2 overflow-auto text-xs">
                  {fileContext.length === 0 && (
                    <p className="text-slate-500">Žádné soubory v kontextu.</p>
                  )}
                  {displayedContext.map((item) => (
                    <div
                      key={item.path}
                      className="flex items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2"
                    >
                      <span className="text-slate-200">{item.path}</span>
                      <button
                        className="text-xs text-rose-300"
                        onClick={() => handleRemoveContext(item.path)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  {filteredContext.length > displayedContext.length && (
                    <p className="text-slate-500">
                      ... showing first {displayedContext.length} of {filteredContext.length}
                    </p>
                  )}
                </div>
              </div>
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
                  setChartType(event.target.value as ChartType)
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

        <section className="grid gap-4 rounded-3xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="flex flex-wrap items-center gap-3 justify-between">
            <h2 className="text-lg font-semibold">Grafy z asistenta</h2>
            {assistantCharts.length > 0 && (
              <button
                className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                onClick={() => setAssistantCharts([])}
              >
                Vymazat grafy
              </button>
            )}
          </div>
          {assistantCharts.length > 0 ? (
            <div className="grid gap-4">
              {assistantCharts.map((chart) => (
                <ResultsChart
                  key={chart.id}
                  title={chart.title}
                  labels={chart.labels}
                  series={chart.series}
                  chartType={chart.type}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
              <p className="text-xs text-slate-500">
                Zatím žádný graf. Zeptejte se v chatu např. „Zobraz, kolik komu
                zbývá sick days v koláčovém grafu“.
              </p>
            </div>
          )}
        </section>

        <section className="grid gap-4 rounded-3xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="text-lg font-semibold">Gemini chat</h2>
          <div className="max-h-96 space-y-4 overflow-auto rounded-2xl border border-slate-800 bg-slate-950 p-4">
            {messages.length === 0 && (
              <p className="text-sm text-slate-500">
                Zeptejte se Gemini něco pomocí kontextu souborů výše.
              </p>
            )}
            {messages.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                className={
                  message.role === "user"
                    ? "rounded-2xl bg-slate-800 px-4 py-3 text-sm"
                    : "rounded-2xl bg-emerald-500/10 px-4 py-3 text-sm"
                }
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
          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <textarea
              className="min-h-[96px] w-full rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-100"
              placeholder="Zeptejte se..."
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
            />
            <button
              className="h-fit rounded-2xl bg-slate-100 px-5 py-3 text-sm font-semibold text-slate-900 disabled:opacity-60"
              onClick={handleSend}
              disabled={isSending}
            >
              {isSending ? "Odesílám..." : "Odeslat"}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
