import { defineConfig } from 'vite';

// GitHub Pages serves this project from https://<user>.github.io/3dland/, so
// built asset URLs need that prefix. Local dev stays at the root.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/3dland/' : '/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
}));
