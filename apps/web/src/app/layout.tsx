import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

/**
 * Two families, down from four.
 *
 * Geist, Geist Mono, Plus Jakarta and JetBrains Mono were all being fetched —
 * two separate monospace families for one monospace role. IBM Plex was drawn
 * for technical and financial interfaces, and its mono shares the sans's
 * skeleton and metrics, so a figure in a table and the label above it read as
 * one voice rather than two.
 */
const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "DataEngine · AI Financial Data Platform",
  description:
    "Learn a client's recurring data workflow once, then execute it every month with only exceptions surfaced.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // No `dark` class. The product is dark-only by decision, and the palette
    // in globals.css is unconditional — a class that gates a theme with no
    // alternative only invites someone to remove it and find out.
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background text-foreground selection:bg-accent/25 selection:text-foreground">
        {children}
      </body>
    </html>
  );
}
