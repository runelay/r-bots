import type { MemInfo } from "./types";

function fieldKb(text: string, name: string) {
  const match = text.match(new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "m"));
  return match ? Number(match[1]) : 0;
}

export function parseMeminfo(text: string): MemInfo {
  return {
    totalMb: Math.floor(fieldKb(text, "MemTotal") / 1024),
    availableMb: Math.floor(fieldKb(text, "MemAvailable") / 1024),
  };
}

export async function readMeminfo(path: string): Promise<MemInfo> {
  return parseMeminfo(await Bun.file(path).text());
}
