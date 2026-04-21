import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import type { ReactNode } from "react";
import ChatWidget from "@/components/ChatWidget";

export const metadata: Metadata = {
  title: "Redin Marketplace",
  description:
    "Trabajo de mantenimiento en Colombia. Técnicos se conectan con Redin para clientes como Davivienda, Tigo, Bolívar.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-screen">
        <header className="border-b border-slate-200 bg-white">
          <nav className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
            <Link href="/" className="font-semibold text-slate-900">
              Redin <span className="text-amber-500">·</span> Marketplace
            </Link>
            <div className="flex items-center gap-4 text-sm">
              <Link href="/me/aplicaciones" className="text-slate-600 hover:text-slate-900">
                Mis aplicaciones
              </Link>
              <Link href="/hr/pipeline" className="text-slate-600 hover:text-slate-900">
                HR
              </Link>
              <Link href="/login" className="text-slate-600 hover:text-slate-900">
                Entrar
              </Link>
            </div>
          </nav>
        </header>
        <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>
        <ChatWidget />
        <footer className="mt-12 border-t border-slate-200 text-center text-xs text-slate-500 py-4">
          Redin · Cali, Colombia · Mantenimiento para clientes empresariales
        </footer>
      </body>
    </html>
  );
}
