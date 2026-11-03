import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { WalletProvider } from "@/components/wallet";
import "./globals.css";

export const metadata: Metadata = {
  title: "Buffer: autonomous business infrastructure on NEAR",
  description:
    "Humans set the rules. Agents run the business. Buffer enforces owner-defined limits on AI agents that sell, buy, deliver and distribute revenue on NEAR.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
