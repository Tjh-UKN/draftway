import {useLayoutEffect, useState} from 'react';
import {isTauri} from '@tauri-apps/api/core';
import {getCurrentWindow} from '@tauri-apps/api/window';

export const appearanceChoices = ['light', 'warm', 'dark', 'system'] as const;
export type AppearanceChoice = (typeof appearanceChoices)[number];
type Palette = Exclude<AppearanceChoice, 'system'>;

const storageKey = 'draftway.appearance';
const systemColorQuery = '(prefers-color-scheme: dark)';

function readAppearance(): AppearanceChoice | undefined {
  try {
    const saved = localStorage.getItem(storageKey);
    return appearanceChoices.find(choice => choice === saved);
  } catch {
    return undefined;
  }
}

function systemColors() {
  return typeof window !== 'undefined' ? window.matchMedia?.(systemColorQuery) : undefined;
}

function updateDocument(palette: Palette) {
  const root = document.documentElement;
  root.dataset.appearance = palette;
  const backdrop = getComputedStyle(root).getPropertyValue('--app-bg').trim();
  if (backdrop) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', backdrop);
}

export function initializeAppearance(fallback: AppearanceChoice = 'light') {
  const choice = readAppearance() ?? fallback;
  updateDocument(choice === 'system' ? (systemColors()?.matches ? 'dark' : 'light') : choice);
}

export function useAppearance(fallback: AppearanceChoice = 'light') {
  const [stored, setStored] = useState(readAppearance);
  const [systemDark, setSystemDark] = useState(() => systemColors()?.matches ?? false);
  const choice = stored ?? fallback;
  const palette: Palette = choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;

  useLayoutEffect(() => {
    const change = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) setStored(readAppearance());
    };
    window.addEventListener('storage', change);
    return () => window.removeEventListener('storage', change);
  }, []);

  useLayoutEffect(() => {
    if (choice !== 'system') return;
    const query = systemColors();
    if (!query) return;
    const change = () => setSystemDark(query.matches);
    change();
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, [choice]);

  useLayoutEffect(() => {
    updateDocument(palette);
  }, [palette]);

  useLayoutEffect(() => {
    if (window.parent !== window || !isTauri()) return;
    const theme = choice === 'system' ? null : choice === 'dark' ? 'dark' : 'light';
    void Promise.resolve().then(() => getCurrentWindow().setTheme(theme)).catch(() => {
      // The document palette also works in hosts that do not expose window appearance controls.
    });
  }, [choice]);

  function setChoice(next: AppearanceChoice) {
    setStored(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // Restricted browser storage still allows a temporary preview.
    }
  }

  return {choice, setChoice, palette};
}
