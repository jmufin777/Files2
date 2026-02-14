/**
 * GET  /api/auth/session  → returns current session info
 * POST /api/auth/session  → logout (destroy session)
 */
import { NextResponse } from "next/server";
import {
  validateSession,
  destroySession,
  sessionCookieName,
} from "@/lib/auth";

export const runtime = "nodejs";

function getSessionId(request: Request): string | undefined {
  const cookieHeader = request.headers.get("cookie") || "";
  const name = sessionCookieName();
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(cookieHeader);
  return match?.[1];
}

export async function GET(request: Request) {
  const sessionId = getSessionId(request);
  const session = await validateSession(sessionId);
  if (!session) {
    return NextResponse.json({ authenticated: false });
  }
  return NextResponse.json({
    authenticated: true,
    email: session.email,
    userId: session.userId,
  });
}

export async function POST(request: Request) {
  let body: { action?: string } = {};
  try {
    body = (await request.json()) as { action?: string };
  } catch {
    // empty body is fine
  }

  if (body.action === "logout") {
    const sessionId = getSessionId(request);
    if (sessionId) {
      await destroySession(sessionId);
    }
    const res = NextResponse.json({ ok: true });
    res.cookies.set(sessionCookieName(), "", {
      httpOnly: true,
      maxAge: 0,
      path: "/",
    });
    return res;
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
