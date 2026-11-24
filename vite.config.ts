import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
          // Remove any leftover _redirects file (e.g. if still present in GitHub repo) to prevent Cloudflare Error 100324
          const distRedirects = path.resolve(distDir, '_redirects');
          if (fs.existsSync(distRedirects)) {
            fs.rmSync(distRedirects, {force: true});
          }
          // Remove any temporary AI Studio chat attachments from dist
          const distAiStudioAssets = path.resolve(distDir, 'assets/aistudio');
          if (fs.existsSync(distAiStudioAssets)) {
            fs.rmSync(distAiStudioAssets, {recursive: true, force: true});
          }
          const indexHtml = path.resolve(distDir, 'index.html');
          const notFoundHtml = path.resolve(distDir, '404.html');
          if (fs.existsSync(indexHtml)) {
            fs.copyFileSync(indexHtml, notFoundHtml);
          }
          // Copy Admin's saved shared-state.json into dist/shared-state.json with all sensitive keys/tokens stripped
          // so static hosts (Cloudflare Pages) serve public site content without exposing Supabase keys or TOTP secrets
          const sharedStateSrc = path.resolve(__dirname, '.data/shared-state.json');
          const sharedStateDist = path.resolve(distDir, 'shared-state.json');
          if (fs.existsSync(sharedStateSrc)) {
            try {
              const raw = JSON.parse(fs.readFileSync(sharedStateSrc, 'utf-8'));
              const publicSettings = { ...(raw.settings || {}) };
              delete publicSettings.totpSecret;
              delete publicSettings.tgBotToken1;
              delete publicSettings.tgBotToken2;
              delete publicSettings.crmApiKey;
              delete publicSettings.crmSupabaseKey;
              delete publicSettings.crmSupabaseUrl;
              const sanitizedState = {
                settings: publicSettings,
                documents: Array.isArray(raw.documents) ? raw.documents : [],
                updatedAt: raw.updatedAt || new Date().toISOString(),
              };
              fs.writeFileSync(sharedStateDist, JSON.stringify(sanitizedState), 'utf-8');
            } catch {
              // ignore if unreadable
            }
          }
        },
      },
    ],
    build: {
      sourcemap: false,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
