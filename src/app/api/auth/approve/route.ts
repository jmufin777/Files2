/**
 * GET /api/auth/approve?token=...
 *
 * Called when an approver clicks the approval link.
 * Creates the user in DB (deny=0), stores approver's identity,
 * and sends magic link to the newly approved user.
 */
import { NextResponse } from "next/server";
import {
  consumeToken,
  findUserByEmail,
  createUser,
  setSecondApprover,
  generateToken,
  storeToken,
  magicLinkExpiryMs,
  sendMail,
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
    return htmlResponse("Chybí schvalovací token.", 400);
  }

  try {
    const result = await consumeToken(token, "approval");
    if (!result) {
      return htmlResponse(
        "Schvalovací odkaz je neplatný nebo již byl použit.",
        400
      );
    }

    const userEmail = result.email;
    const baseUrl = getBaseUrl(request);

    // Determine which approver clicked — we check Referer / just use the
    // order: first click → schvaleni1, second click → schvaleni2.
    const existing = await findUserByEmail(userEmail);

    if (existing && existing.deny === 0) {
      // User already approved — this must be the second approver
      if (!existing.schvaleni2) {
        // Figure out which approver this is (we can't know for sure from a GET,
        // so we just record that a second approval happened)
        const approver1 = process.env.EMAIL_SCHVALENI1?.toLowerCase().trim();
        const approver2 = process.env.EMAIL_SCHVALENI2?.toLowerCase().trim();
        // If schvaleni1 is one of the approvers, the other one is approver 2
        const secondApprover =
          existing.schvaleni1?.toLowerCase() === approver1
            ? approver2 || "unknown"
            : approver1 || "unknown";
        await setSecondApprover(userEmail, secondApprover);
      }
      return htmlResponse(
        `Uživatel <strong>${userEmail}</strong> již byl schválen dříve. Vaše schválení bylo zaznamenáno jako druhé.`,
        200
      );
    }

    // First approval — create user
    const approver1 = process.env.EMAIL_SCHVALENI1?.toLowerCase().trim() || "approver";
    await createUser(userEmail, approver1);

    // Send magic link to the newly approved user
    const expiryMs = magicLinkExpiryMs();
    const magicToken = generateToken();
    await storeToken(
      magicToken,
      userEmail,
      "magic_link",
      new Date(Date.now() + expiryMs)
    );

    const loginLink = `${baseUrl}/api/auth/verify?token=${magicToken}`;
    const expiryMin = Math.round(expiryMs / 60000);

    await sendMail(
      userEmail,
      "Váš přístup byl schválen – Jardovo hledání",
      `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#10b981;">✓ Přístup schválen!</h2>
        <p>Váš přístup do aplikace Jardovo hledání byl schválen. Klikněte na tlačítko níže pro přihlášení:</p>
        <p style="text-align:center;margin:24px 0;">
          <a href="${loginLink}" style="background:#10b981;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">
            Přihlásit se
          </a>
        </p>
        <p style="color:#666;font-size:13px;">
          Platnost odkazu: ${expiryMin} minut.<br/>
          Při dalším přihlášení stačí zadat email — odkaz přijde automaticky.
        </p>
      </div>`
    );

    return htmlResponse(
      `Uživatel <strong>${userEmail}</strong> byl úspěšně schválen a přihlašovací odkaz mu byl odeslán.`,
      200
    );
  } catch (error) {
    console.error("Approve error:", error);
    return htmlResponse("Chyba při schvalování.", 500);
  }
}

function htmlResponse(message: string, status: number): NextResponse {
  const color = status >= 400 ? "#ef4444" : "#10b981";
  const icon = status >= 400 ? "⚠️" : "✓";
  const html = `<!DOCTYPE html>
<html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Schválení uživatele</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;}
.card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:40px;max-width:480px;text-align:center;}
h2{color:${color};}</style></head>
<body><div class="card"><h2>${icon}</h2><p>${message}</p></div></body></html>`;
  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
