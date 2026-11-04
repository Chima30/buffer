import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { AppShell } from "@/components/app-shell";
import { themeScript } from "@/components/theme-toggle";
import { WalletProvider } from "@/components/wallet";
import "./globals.css";

export const metadata: Metadata = {
  title: "Buffer: an AI agent runs the business, a NEAR contract holds the rules",
  description:
    "Humans set the rules. AI agents run the business. A NEAR contract holds the money and enforces the owner's limits on every payment.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full">
        <WalletProvider>
          <AppShell>{children}</AppShell>
        </WalletProvider>
      </body>
    </html>
  );
}
