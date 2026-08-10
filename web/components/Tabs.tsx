"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/run", label: "Run" },
  { href: "/chat", label: "Chat" },
  { href: "/", label: "Markets" },
  { href: "/receipts", label: "Receipts" },
];

export function Tabs() {
  const path = usePathname();
  return (
    <nav className="tabs">
      {TABS.map((t) => {
        const active = t.href === "/" ? path === "/" || path.startsWith("/markets") : path.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} className={active ? "active" : ""}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
