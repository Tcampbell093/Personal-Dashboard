import type { Priority } from "@/lib/types";

/** Maps a priority/importance to a tier color class. */
export function tone(p: Priority | null | undefined): "act" | "aware" | "explore" {
  if (p === "critical" || p === "high") return p === "critical" ? "act" : "aware";
  if (p === "medium") return "aware";
  return "explore";
}

export function Badge({
  children,
  variant,
}: {
  children: React.ReactNode;
  variant?: "act" | "aware" | "explore" | "good";
}) {
  return <span className={`badge ${variant ?? ""}`}>{children}</span>;
}

export function MockTag() {
  return <span className="mocktag">Mock</span>;
}

export function Card({
  title,
  edge,
  className,
  children,
}: {
  title: string;
  edge?: "act" | "aware" | "explore";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`card ${edge ? "edge-" + edge : ""} ${className ?? ""}`}>
      <h2 className="card-title">{title}</h2>
      {children}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** "$1,234.56" */
export function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Human label for an enum-ish value: "estate_sale" -> "Estate sale" */
export function label(v: string): string {
  const s = v.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "Jun 21" */
export function shortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
