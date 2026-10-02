import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";

import { PressFeedback } from "@/components/ui/press-feedback";

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
    "Agenda is a marketplace where brands launch campaigns and creators get paid the fixed price they set — quoted per campaign, released through funded milestones.",
  applicationName: "Agenda",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-canvas text-ink">
        {/* Enables iOS Safari `:active` and drives the shared pressed state. */}
        <PressFeedback />
        {children}
      </body>
    </html>
  );
}
