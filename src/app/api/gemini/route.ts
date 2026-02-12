import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const runtime = "nodejs";

type GeminiRequest = {
  message?: string;
  context?: string;
  // Filtering information
  totalFiles?: number;      // Total files available (before filtering)
  filteredFiles?: number;   // Files actually in context (after filtering)
  contextSize?: number;     // Size of context in bytes
  totalLines?: number;      // Total lines across all files
};

// Rate limiting
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const REQUESTS_PER_WINDOW = 30;
const MAX_REQUEST_SIZE = 50 * 1024 * 1024; // 50MB

// Data size limits for detection
const DATA_SIZE_THRESHOLDS = {
  WARN_FILES: 500,        // Warn if > 500 files
  WARN_SIZE_MB: 10,       // Warn if > 10MB
  WARN_CONTEXT_CHARS: 100_000, // Warn if context > 100k chars
};

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(ip);

  if (!record || now > record.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }

  if (record.count >= REQUESTS_PER_WINDOW) {
    return false;
  }

  record.count++;
  return true;
}

function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0] ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

function checkDataSize(payload: GeminiRequest): { shouldWarn: boolean; reason?: string; details?: string } {
  const { filteredFiles = 0, contextSize = 0, context = "" } = payload;
  const contextChars = context?.length ?? 0;

  // Check if data might be too large for processing
  if (filteredFiles > DATA_SIZE_THRESHOLDS.WARN_FILES) {
    return {
      shouldWarn: true,
      reason: `Velké množství dat: ${filteredFiles} souborů`,
      details: `Zpracování ${filteredFiles} souborů může trvat dlouho. Zvažte filtrování.`
    };
  }

  if (contextSize > DATA_SIZE_THRESHOLDS.WARN_SIZE_MB * 1024 * 1024) {
    const sizeMB = (contextSize / (1024 * 1024)).toFixed(1);
    return {
      shouldWarn: true,
      reason: `Velký objem dat: ~${sizeMB} MB`,
      details: `Kontekt o velikosti ${sizeMB} MB může být pomalejší k zpracování.`
    };
  }

  if (contextChars > DATA_SIZE_THRESHOLDS.WARN_CONTEXT_CHARS) {
    return {
      shouldWarn: true,
      reason: `Dlouhý kontext: ~${contextChars.toLocaleString('cs-CZ')} znaků`,
      details: `Kontext překračuje doporučený limit. Odpověď může být pomalejší.`
    };
  }

  return { shouldWarn: false };
}

export async function POST(request: Request) {
  // Rate limiting check
  const clientIp = getClientIp(request);
  if (!checkRateLimit(clientIp)) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Maximum 30 requests per minute." },
      { status: 429 }
    );
  }

  // Check request content length
  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength) > MAX_REQUEST_SIZE) {
    return NextResponse.json(
      { error: `Request too large. Maximum size: ${MAX_REQUEST_SIZE / 1024 / 1024}MB` },
      { status: 413 }
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing GEMINI_API_KEY." },
      { status: 500 }
    );
  }

  let payload: GeminiRequest = {};
  try {
    const text = await request.text();
    
    // Check if response looks like HTML error page
    if (text.trim().startsWith("<")) {
      return NextResponse.json(
        { 
          error: "Invalid JSON received. Server returned HTML instead of JSON.",
          details: text.substring(0, 300)
        },
        { status: 400 }
      );
    }
    
    payload = JSON.parse(text) as GeminiRequest;
  } catch (parseError) {
    const errorMsg = parseError instanceof Error ? parseError.message : "Unknown parse error";
    return NextResponse.json(
      { 
        error: "Invalid JSON in request body.",
        details: errorMsg
      },
      { status: 400 }
    );
  }

  // Validate message
  if (!payload.message || typeof payload.message !== "string") {
    return NextResponse.json(
      { error: "Message is required and must be a string." },
      { status: 400 }
    );
  }

  // Validate message length
  if (payload.message.length > 50000) {
    return NextResponse.json(
      { error: "Message too long. Maximum 50000 characters." },
      { status: 400 }
    );
  }

  // Check data size and warn if necessary
  const sizeCheck = checkDataSize(payload);
  if (sizeCheck.shouldWarn) {
    return NextResponse.json(
      {
        warning: sizeCheck.reason,
        details: sizeCheck.details,
        filteredFiles: payload.filteredFiles,
        totalFiles: payload.totalFiles,
      },
      { status: 202 } // 202 Accepted - continue but with warning
    );
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const modelName = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    const model = genAI.getGenerativeModel({ model: modelName });

    const chartInstruction = `\n\nIf the user asks to show, visualize, chart or graph data, follow these rules:
1. If requesting a chart with SPECIFIC numbers or data from context: extract the numbers from the context and create the chart
2. If requesting a chart with RANDOM/FICTIONAL data (e.g., "random 500 files", "example chart"): generate plausible fictional data with realistic distribution
3. Always return the chart block using EXACTLY this format at the end:\n[[CHART]]\n{"title":"<short title>","type":"pie|bar|line","labels":["A","B","C"],"series":[10,20,30]}\n[[/CHART]]\nSupport types: pie, bar, line. Only include the chart block if you can provide reliable or appropriately generated numbers. Keep the rest of the answer in Czech.`;
    
    // Count files and stats from context header if available
    // buildContext() returns format: "# Context summary\ntotal_files=N\ntotal_size_bytes=X\n..."
    // Use filteredFiles from payload - it's the actual count after filtering
    const fileCount = payload.filteredFiles ?? null;
    const totalFilesBeforeFilter = payload.totalFiles ?? fileCount;
    const isFiltered = totalFilesBeforeFilter && fileCount && totalFilesBeforeFilter !== fileCount;
    
    // Use provided totalLines or fallback to payload totalLines
    const totalLines = payload.totalLines?.toString() ?? null;
    const totalSize = payload.contextSize 
      ? `${(payload.contextSize / 1024).toFixed(1)} KB`
      : null;

    const contextCountsInstruction = fileCount
      ? `\n\n🚨 CRITICAL FILE COUNT INSTRUCTION 🚨
The Context text below may contain "total_files=N" but IGNORE THAT VALUE.

IMPORTANT DISTINCTION:
${isFiltered 
  ? `- Total files in full context: ${totalFilesBeforeFilter} files
- Files VISIBLE and ready for analysis (filtered): ${fileCount} files
- Only these ${fileCount} filtered files are shown in the Context below
- Statistics below (lines, size) are ONLY for the ${fileCount} filtered files` 
  : `- Total files in context: ${fileCount} files`}
${totalLines ? `- Lines in ${isFiltered ? 'filtered' : 'all'} files: ${totalLines}` : ''}
${totalSize ? `- Size of ${isFiltered ? 'filtered' : 'all'} files: ${totalSize}` : ''}

When the user asks in Czech "kolik je/máme/mám souborů/souboru/soubory v kontextu" or ANY variation with "kolik" + "soubor*", you MUST respond EXACTLY:
${isFiltered 
  ? `"V kontextu máte celkem ${totalFilesBeforeFilter} souborů. Pro práci jsou připraveny ${fileCount} soubory (filtrováno podle cesty)${totalLines ? `, celkem asi ${totalLines} řádků` : ''}${totalSize ? ` a ${totalSize}` : ''}."`
  : `"V kontextu máte ${fileCount} souborů${totalLines ? `, celkem asi ${totalLines} řádků` : ''}${totalSize ? ` a ${totalSize}` : ''}."`}

When answering questions, work ONLY with the ${fileCount} file${fileCount !== 1 ? 's' : ''} shown in Context below.
DO NOT use any value from "total_files=" in the Context section below. Use ONLY the numbers stated above.`
      : '';
    
    const wantsStructured = /(strukturov|structured|prehled|přehled)/i.test(
      payload.message
    );
    const structuredInstruction = wantsStructured
      ? `\n\nThe user explicitly wants structured results. You MUST include a structured results block at the end using EXACTLY this format (even if you already wrote prose):\n[[STRUCTURED]]\n{"groups":[{"client":"CategoryName","files":[{"path":"path/to/file.xlsx","description":"Brief description"}]}],"summary":"Brief summary"}\n[[/STRUCTURED]]\nGroup files into sensible categories based on the context. In the files array, include relevant file paths from the Context. If no files are found, return an empty groups array and explain in the summary. Keep descriptions brief and in Czech.`
      : `\n\nIf the user asks about finding files for specific clients or entities (e.g., "mám klienta colonnade a helvetia"), organize your response to include a structured results block at the end using EXACTLY this format:\n[[STRUCTURED]]\n{"groups":[{"client":"ClientName","files":[{"path":"path/to/file.xlsx","description":"Brief description"}]}],"summary":"Brief summary"}\n[[/STRUCTURED]]\nIn the files array, include all relevant file paths from the context that belong to each client. Keep descriptions brief and in Czech.`;
    const accessInstruction = `\n\nYou have access ONLY to the provided Context text. Never say things like "Nemám přístup k obsahu souborů" or "nemohu spočítat" because you do have access to whatever text is provided. If the provided Context does not include the needed file contents, say in Czech that the provided context is missing the relevant file contents and ask the user to add the relevant files to context.`;

    const prompt = payload.context
      ? `${contextCountsInstruction}\n\nContext:\n${payload.context}\n\nUser:\n${payload.message}${chartInstruction}${structuredInstruction}${accessInstruction}`
      : `${payload.message}${chartInstruction}${structuredInstruction}${accessInstruction}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    return NextResponse.json({ text });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Gemini request failed.";
    console.error("[Gemini API Error]", errorMsg);
    
    return NextResponse.json(
      {
        error: errorMsg,
        hint: "Check if your context contains valid data. Invalid/HTML responses are gracefully handled.",
      },
      { status: 500 }
    );
  }
}
