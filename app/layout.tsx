import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Deflect — Dispute Workspace",
  description: "A workspace for dispute recommendations, policy checks, and auditable actions.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
