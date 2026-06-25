"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setPending(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(d?.error ?? "Login failed.");
      return;
    }
    // Only allow same-site relative redirects.
    router.replace(next.startsWith("/") ? next : "/");
    router.refresh();
  }

  return (
    <form className="loginbox" onSubmit={submit}>
      <div className="wordmark" style={{ fontSize: 18 }}>
        Xanther<span className="dot">.</span>
      </div>
      <p className="sub" style={{ margin: "4px 0 18px" }}>
        Enter your password to continue.
      </p>
      <input
        className="taskadd-title"
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={pending}
        autoFocus
        aria-label="Password"
        style={{ width: "100%", marginBottom: 12, padding: "9px 11px" }}
      />
      <button
        className="btn"
        type="submit"
        disabled={pending || !password}
        style={{ width: "100%", padding: "9px" }}
      >
        {pending ? "Checking…" : "Unlock"}
      </button>
      {error && (
        <div className="taskadd-error" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
    </form>
  );
}
