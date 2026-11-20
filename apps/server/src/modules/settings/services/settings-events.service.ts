export const settingsAreas = [
  "bots",
  "sections",
  "schedules",
  "servers",
  "repos",
  "vault",
  "accounts",
  "usage",
  "integrations",
  "connectors",
  "preferences",
  "conversations",
] as const;
export type SettingsArea = (typeof settingsAreas)[number];

const listeners = new Set<(areas: SettingsArea[]) => void>();

export function onSettingsChange(listener: (areas: SettingsArea[]) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitSettingsChange(areas: SettingsArea[]) {
  if (areas.length === 0) return;
  const unique = [...new Set(areas)];
  for (const listener of listeners) listener(unique);
}
