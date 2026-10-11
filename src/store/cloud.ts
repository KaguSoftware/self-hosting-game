"use client";
import { create } from "zustand";
import { mergeProgress, migrateProgress } from "@/engine/progress";
import { snapshot, useProgress } from "./progress";

type Status = "off" | "syncing" | "ok" | "error" | "unavailable";

interface CloudStore {
  player: string | null;
  status: Status;
  message: string;
  connect(name: string): Promise<void>;
  disconnect(): void;
  push(): Promise<void>;
}

const KEY = "shg-player";

function readPlayer(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function writePlayer(name: string | null) {
  try {
    if (name) window.localStorage.setItem(KEY, name);
    else window.localStorage.removeItem(KEY);
  } catch {
    /* private mode: cloud name just won't stick */
  }
}

export const useCloud = create<CloudStore>((set, get) => ({
  player: null,
  status: "off",
  message: "",
  async connect(raw) {
    const name = raw.trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,32}$/.test(name)) {
      set({ status: "error", message: "Use 2 to 32 letters, numbers, - or _" });
      return;
    }
    set({ player: name, status: "syncing", message: "" });
    writePlayer(name);
    try {
      const res = await fetch(`/api/progress?player=${encodeURIComponent(name)}`);
      if (res.status === 503) {
        set({ status: "unavailable", message: "Cloud save is not set up on this deployment. Progress stays in this browser." });
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (data.progress) {
        const merged = mergeProgress(snapshot(), migrateProgress(data.progress));
        useProgress.getState().replaceAll(merged);
      }
      await get().push();
    } catch {
      set({ status: "error", message: "Could not reach cloud save. Will retry on next change." });
    }
  },
  disconnect() {
    writePlayer(null);
    set({ player: null, status: "off", message: "" });
  },
  async push() {
    const name = get().player;
    if (!name || get().status === "unavailable") return;
    set({ status: "syncing" });
    try {
      const res = await fetch(`/api/progress?player=${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(snapshot()),
      });
      if (res.status === 503) {
        set({ status: "unavailable", message: "Cloud save is not set up on this deployment." });
        return;
      }
      set({ status: res.ok ? "ok" : "error", message: res.ok ? "" : "Cloud save failed. Will retry." });
    } catch {
      set({ status: "error", message: "Offline. Progress is safe in this browser." });
    }
  },
}));

let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;

/** Call once on the client: restores the player name and pushes changes (debounced). */
export function startCloudSync() {
  if (started || typeof window === "undefined") return;
  started = true;
  const name = readPlayer();
  if (name) void useCloud.getState().connect(name);
  useProgress.subscribe((s, prev) => {
    if (s.xp === prev.xp && s.completed === prev.completed && s.review === prev.review && s.settings === prev.settings) return;
    if (!useCloud.getState().player) return;
    clearTimeout(timer);
    timer = setTimeout(() => void useCloud.getState().push(), 2500);
  });
}
