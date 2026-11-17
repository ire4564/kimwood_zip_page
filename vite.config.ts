import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages는 https://<user>.github.io/kimwood_zip_page/ 아래에서 서비스되므로 경로 접두사가 필요
// (`vite build --mode pages`일 때만 적용, 로컬·Vercel은 루트 경로)
export default defineConfig(({ mode }) => ({
  base: mode === 'pages' ? '/kimwood_zip_page/' : '/',
  plugins: [react()],
}));
