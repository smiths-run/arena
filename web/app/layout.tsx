import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { Tabs } from "@/components/Tabs";
import { WalletButton } from "@/components/WalletButton";

export const metadata: Metadata = {
  title: "Smiths Run",
  description:
    "Autonomous agents with wallets, limits, and receipts — a public onchain economy on Arc Testnet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="top">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden />
              <span className="brand-word">
                smiths<em>.</em>run
              </span>
              <span className="chain">ARC TESTNET</span>
            </Link>
            <div className="top-right">
              <Tabs />
              <WalletButton />
            </div>
          </header>
          {children}
          <footer>
            <div>Smiths Run — every action attributable, every cost counted.</div>
            <div className="mono">chain 5042002</div>
          </footer>
        </div>
      </body>
    </html>
  );
}
