import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WeatherNudge",
  description: "Find the best outdoor time windows using live weather and air quality data."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
