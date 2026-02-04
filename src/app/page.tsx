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

type ChartType = "pie" | "bar";
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
};

const MAX_FILE_BYTES = 200_000;
const MAX_CONTEXT_CHARS = 20_000;
const SEARCH_BATCH_SIZE = 25;
const REQUEST_TIMEOUT_MS = 20_000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build"]);
const DEFAULT_OCR_MAX_PAGES = 5;
const OCR_BATCH_SIZE = 5;
const CONTEXTS_STORAGE_KEY = "nai.savedContexts.v1";

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
  doc: { numPages: number; getPage: (n: number) => Promise<any> },
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
    const page = await doc.getPage(pageNumber);
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

  output = summaryLines.join("\n");
  for (const file of files) {
    const meta: string[] = [];
    meta.push(`size_bytes=${file.size}`);
    if (file.modified) meta.push(`modified=${file.modified}`);
    if (file.created) meta.push(`created=${file.created}`);
    const header = meta.length > 0 ? `${file.path} (${meta.join(", ")})` : file.path;
    const next = `# ${header}\n${file.content}`;
    if (output.length + next.length > MAX_CONTEXT_CHARS) {
      const remaining = MAX_CONTEXT_CHARS - output.length;
      if (remaining > 0) {
        output += `\n\n${next.slice(0, remaining)}`;
      }
      output += "\n\n[Context truncated]";
      break;
    }
    output = output ? `${output}\n\n${next}` : next;
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
  const [isIndexed, setIsIndexed] = useState(false);
  const [selectAllChecked, setSelectAllChecked] = useState(false);
  const [sambaPath, setSambaPath] = useState<string>("");
  const [sambaFiles, setSambaFiles] = useState<any[]>([]);
  const [isSambaScanning, setIsSambaScanning] = useState(false);
  const [sambaStats, setSambaStats] = useState<any>(null);
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
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [indexProgress, setIndexProgress] = useState<LoadProgress | null>(null);

  const contextText = useMemo(() => buildContext(fileContext), [fileContext]);

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
    window.localStorage.setItem(
      CONTEXTS_STORAGE_KEY,
      JSON.stringify(savedContexts)
    );
  }, [savedContexts]);

  const activeContext = useMemo(() => {
    if (!activeContextId) return null;
    return savedContexts.find((ctx) => ctx.id === activeContextId) ?? null;
  }, [activeContextId, savedContexts]);

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
        files?: any[];
        stats?: any;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "Samba scan failed.");
      }
      const files = data.files ?? [];
      setSambaFiles(files);
      setSambaStats(data.stats);
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
      setStatus(`✓ Added ${data.fileName}`);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Extraction failed."
      );
    }
  };

  const addSambaFilesToContext = async (files: any[]) => {
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
      id: crypto.randomUUID(),
      name,
      sambaPath: newContextSambaPath.trim(),
      autoSyncMinutes: 0,
      extensions: [],
      notifyOnSync: false,
      files: {},
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
    try {
      const response = await fetch("/api/samba", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sambaPath: activeContext.sambaPath.trim(),
          recursive: true,
          maxFiles: 5000,
          extensions: activeContext.extensions.length
            ? activeContext.extensions
            : undefined,
        }),
      });
      const data = (await response.json()) as {
        files?: any[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "Samba scan failed.");
      }
      const sambaFilesList = (data.files ?? []).filter(
        (file) => file.type === "file"
      );
      if (sambaFilesList.length === 0) {
        setStatus("Nebyl nalezen žádný soubor pro indexaci.");
        setSyncProgress(null);
        return;
      }

      const updatedFiles = { ...activeContext.files };
      const filesToIndex: Array<{ name: string; content: string }> = [];

      for (let index = 0; index < sambaFilesList.length; index += 1) {
        const file = sambaFilesList[index];
        const meta = updatedFiles[file.path] ?? {};
        const unchanged =
          meta.modified === file.modified && meta.size === file.size;
        if (unchanged) {
          continue;
        }
        setSyncProgress({
          label: `${file.name} (${index + 1}/${sambaFilesList.length})`,
          percent: Math.round(((index + 1) / sambaFilesList.length) * 100),
        });
        const extractResponse = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filePath: file.path,
            fileName: file.name,
          }),
        });
        const extractData = (await extractResponse.json()) as {
          text?: string;
          error?: string;
        };
        if (!extractResponse.ok || !extractData.text) {
          continue;
        }
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
        setStatus("Žádné změny k indexaci.");
        setSyncProgress(null);
        handleUpdateActiveContext({
          lastIndexedAt: new Date().toISOString(),
          files: updatedFiles,
        });
        setIsIndexed(true);
        return;
      }

      const indexResponse = await fetch("/api/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: filesToIndex,
          incremental: true,
        }),
      });
      const indexData = (await indexResponse.json()) as {
        error?: string;
      };
      if (!indexResponse.ok) {
        throw new Error(indexData.error ?? "Indexing failed.");
      }

      handleUpdateActiveContext({
        lastIndexedAt: new Date().toISOString(),
        files: updatedFiles,
      });
      setIsIndexed(true);
      setStatus(`✓ Kontext ${activeContext.name} synchronizován.`);
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
    }
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
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "Indexing failed.");
      }
      setIndexProgress({ label: "Hotovo", percent: 100 });
      setIsIndexed(true);
      setStatus(
        `✓ Indexed ${data.filesCount} files → ${data.chunksCount} chunks`
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

  const handleSend = async () => {
    const trimmed = chatInput.trim();
    if (!trimmed) {
      return;
    }
    setIsSending(true);
    setStatus(null);
    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
    setChatInput("");
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS
      );

      // Use indexed search if available, otherwise fall back to direct gemini
      const endpoint = isIndexed ? "/api/search" : "/api/gemini";
      const body =
        isIndexed
          ? JSON.stringify({ query: trimmed })
          : JSON.stringify({ message: trimmed, context: contextText });

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = (await response.json()) as { text?: string; error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "Request failed.");
      }
      const { cleanText, chart } = extractChartBlock(data.text ?? "");
      if (chart) {
        setAssistantCharts((prev) => [
          ...prev,
          { ...chart, id: crypto.randomUUID() },
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
            error instanceof Error
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
                  onChange={(event) => setActiveContextId(event.target.value)}
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
                  onClick={handleSyncActiveContext}
                >
                  Sync now
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
                disabled={fileContext.length === 0 || isIndexing}
              >
                {isIndexing
                  ? "Indexování..."
                  : isIndexed
                    ? "✓ Indexováno"
                    : "Indexovat soubory do databáze "}
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
              <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
                <h3 className="text-sm font-semibold text-slate-200">
                  Kontext ({fileContext.length})
                </h3>
                <p className="mt-1 text-xs text-slate-400">
                  {contextText.length} / {MAX_CONTEXT_CHARS} chars
                </p>
                <div className="mt-3 max-h-56 space-y-2 overflow-auto text-xs">
                  {fileContext.length === 0 && (
                    <p className="text-slate-500">Žádné soubory v kontextu.</p>
                  )}
                  {fileContext.map((item) => (
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
