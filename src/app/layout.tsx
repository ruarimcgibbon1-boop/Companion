import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Intraday Trading Companion",
  description: "Professional intraday market scanner and analysis dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning: browser extensions inject attributes (e.g.
    // bis_register, __processed_*) onto <html>/<body> before React hydrates,
    // which would otherwise log a hydration mismatch. This only relaxes the
    // warning for these two elements' own attributes, not their descendants.
    <html lang="en" className={`${geistMono.variable} h-full dark`} suppressHydrationWarning>
      <body className="h-full bg-[#0e1117] text-gray-100 antialiased" suppressHydrationWarning>{children}</body>
    </html>
  );
}
