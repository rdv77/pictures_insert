import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { fileURLToPath } from 'node:url';
export default defineConfig(async () => {
  if (process.env.SITE_TARGET === 'sites') {
    const config = (await import('./vite.sites')).default;
    return typeof config === 'function' ? config({command:'build',mode:'production'}) : config;
  }
  return {
    plugins: [react()],
    resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
    css: { postcss: { plugins: [tailwindcss()] } },
    build: { outDir: 'dist/web' },
  };
});
