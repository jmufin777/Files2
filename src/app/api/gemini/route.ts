import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const runtime = "nodejs";

type GeminiRequest = {
  message?: string;
  context?: string;
};

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing GEMINI_API_KEY." },
      { status: 500 }
    );
  }

  let payload: GeminiRequest = {};
  try {
    payload = (await request.json()) as GeminiRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!payload.message) {
    return NextResponse.json({ error: "Message is required." }, { status: 400 });
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
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Gemini request failed.",
      },
      { status: 500 }
    );
  }
}
