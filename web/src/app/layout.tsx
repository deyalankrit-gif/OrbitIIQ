import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OrbitIQ",
  description: "OrbitIQ student learning app.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
