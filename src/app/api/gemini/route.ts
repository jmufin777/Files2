import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const runtime = "nodejs";

type GeminiRequest = {
  message?: string;
  context?: string;
};

// Rate limiting
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const REQUESTS_PER_WINDOW = 30;
const MAX_REQUEST_SIZE = 50 * 1024 * 1024; // 50MB

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

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const modelName = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    const model = genAI.getGenerativeModel({ model: modelName });

    const chartInstruction = `\n\nIf the user asks to show, visualize, chart or graph data, extract the numbers from the context and return a chart block using EXACTLY this format at the end:\n[[CHART]]\n{"title":"<short title>","type":"pie|bar","labels":["A","B"],"series":[10,20]}\n[[/CHART]]\nOnly include the chart block if you have reliable numbers. Keep the rest of the answer in Czech.`;
    
    // Count files and stats from context header if available
    const contextCountMatch = payload.context?.match(/^Kontext \((\d+)\)\s*\n/m);
    const fileCount = contextCountMatch ? parseInt(contextCountMatch[1], 10) : null;
    const totalLinesMatch = payload.context?.match(/Řádky:\s*([\d\s,]+)/);
    const totalSizeMatch = payload.context?.match(/Velikost:\s*([\d.,\sKMBG]+)/);
    const totalLines = totalLinesMatch ? totalLinesMatch[1].trim() : null;
    const totalSize = totalSizeMatch ? totalSizeMatch[1].trim() : null;

    const contextCountsInstruction = fileCount
      ? `\n\nIMPORTANT: The user is working with a Context section that contains exactly ${fileCount} files${totalLines ? ` totaling approximately ${totalLines} lines` : ''}${totalSize ? ` and ${totalSize}` : ''}. 
When the user asks a question in Czech about the NUMBER/COUNT of files in the context, you must recognize patterns like:
- Questions containing "kolik" (how many) + any form of "soubor" (file)
- This includes ALL grammatical variations: "souboru", "souborů", "soubory", "soubor"
- Examples: "kolik je souboru", "kolik je souborů", "kolik je soubory", "kolik máme souboru", "kolik mame souboru", "kolik mám souboru", "počet souboru", "počet souborů"
- When you detect such a question, ALWAYS respond with ONLY: "V kontextu máte ${fileCount} souborů${totalLines ? `, celkem asi ${totalLines} řádků` : ''}${totalSize ? ` a ${totalSize}` : ''}." in Czech. Nothing else - just this answer.`
      : '';
    
    const wantsStructured = /(strukturov|structured|prehled|přehled)/i.test(
      payload.message
    );
    const structuredInstruction = wantsStructured
      ? `\n\nThe user explicitly wants structured results. You MUST include a structured results block at the end using EXACTLY this format (even if you already wrote prose):\n[[STRUCTURED]]\n{"groups":[{"client":"CategoryName","files":[{"path":"path/to/file.xlsx","description":"Brief description"}]}],"summary":"Brief summary"}\n[[/STRUCTURED]]\nGroup files into sensible categories based on the context. In the files array, include relevant file paths from the Context. If no files are found, return an empty groups array and explain in the summary. Keep descriptions brief and in Czech.`
      : `\n\nIf the user asks about finding files for specific clients or entities (e.g., "mám klienta colonnade a helvetia"), organize your response to include a structured results block at the end using EXACTLY this format:\n[[STRUCTURED]]\n{"groups":[{"client":"ClientName","files":[{"path":"path/to/file.xlsx","description":"Brief description"}]}],"summary":"Brief summary"}\n[[/STRUCTURED]]\nIn the files array, include all relevant file paths from the context that belong to each client. Keep descriptions brief and in Czech.`;
    const accessInstruction = `\n\nYou have access ONLY to the provided Context text. Never say things like "Nemám přístup k obsahu souborů" or "nemohu spočítat" because you do have access to whatever text is provided. If the provided Context does not include the needed file contents, say in Czech that the provided context is missing the relevant file contents and ask the user to add the relevant files to context.`;

    const prompt = payload.context
      ? `Context:\n${payload.context}\n\nUser:\n${payload.message}${chartInstruction}${contextCountsInstruction}${structuredInstruction}${accessInstruction}`
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
