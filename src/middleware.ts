import { NextResponse, type NextRequest } from "next/server";

/**
 * Auth middleware — checks for session cookie on protected routes.
 * Public routes: /login, /api/auth/*, /_next/*, /favicon.ico, static assets.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── Public paths (no auth needed) ──────────────────────────────────
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    pathname.endsWith(".ico") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".svg") ||
    pathname.endsWith(".jpg") ||
    pathname.endsWith(".css") ||
    pathname.endsWith(".js")
  ) {
    return NextResponse.next();
  }

  // ── Check session cookie ───────────────────────────────────────────
  const sessionCookie = request.cookies.get("nai_session");

  if (!sessionCookie?.value) {
    // API routes → 401 JSON
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Nepřihlášen. Přihlaste se prosím." },
        { status: 401 }
      );
    }
    // Pages → redirect to login
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  // Cookie exists — let request through.
  // Full session validation (DB check) happens in the API routes themselves
  // via validateSession(). The middleware is a fast first-pass check.
  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static, _next/image (Next.js internals)
     * - favicon.ico
     */
    "/((?!_next/static|_next/image|favicon\\.ico).*)",
  ],
};
