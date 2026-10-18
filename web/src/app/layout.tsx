import "./globals.css";

export const metadata = {
  title: "FB Auto-Poster",
  description: "Bulk Facebook Page auto-poster",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
