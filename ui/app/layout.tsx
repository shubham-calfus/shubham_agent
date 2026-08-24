import type { Metadata } from "next";
import "./globals.css";
import { AppProvider } from "@/lib/store";
import { ReduxProvider } from "@/components/ReduxProvider";
import { Sidebar } from "@/components/Sidebar";
import { Toaster } from "@/components/Toaster";

export const metadata: Metadata = {
  title: "ACT Studio — Aetherion",
  description: "Author, trigger and inspect ACT Agent recordings.",
  icons: { icon: "/aetherion-mark.png" },
};

// Set the theme attribute before first paint to avoid a light/dark flash.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('act-theme');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='light';}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <ReduxProvider>
          <AppProvider>
            <div className="flex min-h-screen">
              <Sidebar />
              <main className="ml-64 min-w-0 flex-1">{children}</main>
            </div>
            <Toaster />
          </AppProvider>
        </ReduxProvider>
      </body>
    </html>
  );
}
