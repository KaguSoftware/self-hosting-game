"use client";
import { create } from "zustand";

export interface Toast {
  id: number;
  text: string;
  kind: "xp" | "info" | "warn";
}

interface UiStore {
  dictOpen: boolean;
  dictQuery: string;
  openDict(q?: string): void;
  closeDict(): void;
  toasts: Toast[];
  toast(text: string, kind?: Toast["kind"]): void;
  confetti: number;
  fireConfetti(): void;
  shake: number;
  doShake(): void;
}

let tid = 1;

export const useUi = create<UiStore>((set) => ({
  dictOpen: false,
  dictQuery: "",
  openDict: (q = "") => set({ dictOpen: true, dictQuery: q }),
  closeDict: () => set({ dictOpen: false }),
  toasts: [],
  toast: (text, kind = "info") => {
    const id = tid++;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 2200);
  },
  confetti: 0,
  fireConfetti: () => set((s) => ({ confetti: s.confetti + 1 })),
  shake: 0,
  doShake: () => set((s) => ({ shake: s.shake + 1 })),
}));
