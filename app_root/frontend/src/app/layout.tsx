import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '통역 시스템 - Translation System',
  description: '실시간 통역 상담 시스템',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  )
}
