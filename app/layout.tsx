import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Xanther",
  description: "Triage what to act on, be aware of, and explore — every day.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
