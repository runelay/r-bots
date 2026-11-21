import { readFileSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import type { EnvironmentCapacity } from "@runelay-bots/protocol";
import { bytesPerMb, kbPerMb, meminfoFile } from "../constants/environments.constants";

function readText(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function meminfoMb(text: string, field: string) {
  const match = text.match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "m"));
  return match ? Math.floor(Number(match[1]) / kbPerMb) : null;
}

export function readLocalCapacity(path = meminfoFile): EnvironmentCapacity {
  const text = readText(path);
  return {
    cpus: cpus().length,
    memTotalMb: meminfoMb(text, "MemTotal") ?? Math.floor(totalmem() / bytesPerMb),
    memFreeMb: meminfoMb(text, "MemAvailable") ?? Math.floor(freemem() / bytesPerMb),
    boxesRunning: 0,
    boxesPaused: 0,
    maxBoxes: 0,
  };
}
