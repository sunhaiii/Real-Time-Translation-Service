/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  // 환경 변수 설정
  env: {
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL,
  },
  // 프로덕션 빌드 최적화
  swcMinify: true,
}

module.exports = nextConfig
