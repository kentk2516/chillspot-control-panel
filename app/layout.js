import "./styles.css";

export const metadata = {
  title: "CHILL SPOT Control",
  description: "Self-service rental control panel"
};

export default function RootLayout({ children }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
