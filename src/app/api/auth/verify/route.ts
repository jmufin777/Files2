/**
 * GET /api/auth/verify?token=...
 *
 * Validates magic-link token, creates session, redirects to app.
 */
import { NextResponse } from "next/server";
import {
  consumeToken,
  findUserByEmail,
  createSession,
  sessionCookieName,
  sessionMaxAge,
} from "@/lib/auth";

export const runtime = "nodejs";

function getBaseUrl(request: Request): string {
  const envBase =
    process.env.APP_BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "";
  if (envBase) {
    return envBase.replace(/\/$/, "");
  }
  const host =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    "localhost:3000";
  const proto = request.headers.get("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return htmlResponse("Chybí token.", 400);
  }

  try {
    const result = await consumeToken(token, "magic_link");
    if (!result) {
      return htmlResponse(
        "Odkaz je neplatný nebo vypršel. Zkuste se přihlásit znovu.",
        400
      );
    }

    const user = await findUserByEmail(result.email);
    if (!user || user.deny !== 0) {
      return htmlResponse("Váš účet není schválen.", 403);
    }

    const sessionId = await createSession(user.id);

    // Set session cookie & redirect to home
    const baseUrl = getBaseUrl(request);
    const res = NextResponse.redirect(`${baseUrl}/`);
    res.cookies.set(sessionCookieName(), sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: sessionMaxAge(),
      path: "/",
    });
    return res;
  } catch (error) {
    console.error("Verify error:", error);
    return htmlResponse("Chyba při ověřování odkazu.", 500);
  }
}

function htmlResponse(message: string, status: number): NextResponse {
  const color = status >= 400 ? "#ef4444" : "#10b981";
  const html = `<!DOCTYPE html>
<html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ověření</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;}
.card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:40px;max-width:420px;text-align:center;}
h2{color:${color};}
a{color:#10b981;}</style></head>
<body><div class="card"><h2>${status >= 400 ? "⚠️" : "✓"}</h2><p>${message}</p>
${status >= 400 ? '<p><a href="/login">Zpět na přihlášení</a></p>' : ""}
</div></body></html>`;
  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
