import { cpSync, mkdirSync } from 'node:fs';
// The editor resolves font URLs at runtime. Ship all subsets, including Chinese,
// so both the Windows WebView and exported diagrams work without a CDN.
mkdirSync('public/excalidraw', { recursive: true });
cpSync('node_modules/@excalidraw/excalidraw/dist/prod/fonts', 'public/excalidraw/fonts', { recursive: true });
