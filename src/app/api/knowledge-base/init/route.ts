import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST() {
  // Initialize/reload knowledge base from database
  // In future: persist metadata, handle caching, rebuild indices
  
  try {
    // For now, just validate that we can query the KB
    const baseUrl = process.env.VERCEL_URL 
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000";
    
    const statusRes = await fetch(`${baseUrl}/api/knowledge-base/status`);
    if (!statusRes.ok) {
      throw new Error("Failed to initialize knowledge base");
    }
    
    const data = await statusRes.json();
    return NextResponse.json({
      success: true,
      message: data.initialized 
        ? `Knowledge base initialized: ${data.totalFiles} files, ${data.totalChunks} chunks`
        : "No knowledge base found. Index files first.",
      ...data,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Initialization failed.",
      },
      { status: 500 }
    );
  }
}
