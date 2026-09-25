import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: {
    default: "Agenda — Turn attention into income",
    template: "%s · Agenda",
  },
  description:
    "Agenda is a marketplace where brands launch campaigns and creators earn from verified audience attention.",
  applicationName: "Agenda",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-canvas text-ink">
        {children}
      </body>
    </html>
  );
}
