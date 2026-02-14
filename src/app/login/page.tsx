"use client";

import { useState, type FormEvent } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [needsApproval, setNeedsApproval] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    setIsLoading(true);
    setStatus(null);
    setIsSuccess(false);
    setNeedsApproval(false);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
        needsApproval?: boolean;
      };

      if (res.ok && data.ok) {
        setIsSuccess(true);
        if (data.needsApproval) {
          setNeedsApproval(true);
        }
        setStatus(data.message || "Odkaz byl odeslán.");
      } else {
        setStatus(data.error || data.message || "Přihlášení selhalo.");
      }
    } catch {
      setStatus("Chyba při odesílání. Zkuste to znovu.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-slate-900 border border-slate-700 rounded-3xl p-8 shadow-2xl">
          {/* Header */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-slate-100 mb-2">
              Jardovo hledání
            </h1>
            <p className="text-slate-400 text-sm">
              Přihlaste se pomocí svého emailu
            </p>
          </div>

          {/* Success state */}
          {isSuccess ? (
            <div className="text-center">
              <div
                className={`rounded-2xl p-6 mb-4 ${
                  needsApproval
                    ? "bg-amber-900/40 border border-amber-700"
                    : "bg-emerald-900/40 border border-emerald-700"
                }`}
              >
                <div className="text-4xl mb-3">
                  {needsApproval ? "⏳" : "✉️"}
                </div>
                <h2
                  className={`text-lg font-semibold mb-2 ${
                    needsApproval ? "text-amber-200" : "text-emerald-200"
                  }`}
                >
                  {needsApproval ? "Čeká se na schválení" : "Zkontrolujte email"}
                </h2>
                <p
                  className={`text-sm ${
                    needsApproval ? "text-amber-300" : "text-emerald-300"
                  }`}
                >
                  {status}
                </p>
              </div>
              <button
                onClick={() => {
                  setIsSuccess(false);
                  setNeedsApproval(false);
                  setStatus(null);
                  setEmail("");
                }}
                className="text-sm text-slate-400 hover:text-slate-200 underline"
              >
                Zkusit jiný email
              </button>
            </div>
          ) : (
            /* Login form */
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div>
                <label
                  htmlFor="email"
                  className="block text-sm font-medium text-slate-300 mb-1.5"
                >
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  autoFocus
                  placeholder="vas@email.cz"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-xl border border-slate-600 bg-slate-800 px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 transition"
                />
              </div>

              {status && !isSuccess && (
                <div className="rounded-xl bg-red-900/40 border border-red-700 px-4 py-3 text-sm text-red-300">
                  {status}
                </div>
              )}

              <button
                type="submit"
                disabled={isLoading || !email.trim()}
                className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 px-4 py-3 text-sm font-semibold text-white transition"
              >
                {isLoading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg
                      className="animate-spin h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
                    </svg>
                    Odesílám...
                  </span>
                ) : (
                  "Přihlásit se"
                )}
              </button>

              <p className="text-center text-xs text-slate-500 mt-2">
                Na váš email bude odeslán přihlašovací odkaz.
                <br />
                Žádné heslo není potřeba.
              </p>
            </form>
          )}
        </div>

        <p className="text-center text-xs text-slate-600 mt-6">
          © {new Date().getFullYear()} Jardovo hledání
        </p>
      </div>
    </div>
  );
}
