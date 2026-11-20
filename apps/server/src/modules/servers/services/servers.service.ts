import { randomBytes } from "node:crypto";
import { readSetting, writeSetting } from "../../../db/settings";
import { ValidationError } from "../../../shared/errors";
import {
  type DevServer,
  forgetServer,
  getServer,
  launchServer,
  type PublicDevServer,
  restartServer,
  stopDevServer,
  toolOf,
  viewServer,
} from "../../code/services/dev-server.service";
import { linkEnvFiles, loadEnv, projectKey, readScripts, resolveProject, scriptCommand } from "./projects.service";

export interface ServerProfile {
  id: string;
  name: string;
  path: string;
  cwd: string;
  script: string | null;
  cmd: string | null;
  port: number | null;
}

const profilesKey = "servers.profiles";

export async function listProfiles() {
  return readSetting<ServerProfile[]>(profilesKey, []);
}

function slug(text: string) {
  return (
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || `perfil-${randomBytes(3).toString("hex")}`
  );
}

function optionalText(value: unknown, max: number) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > max) throw new ValidationError("Valor inválido.", "profile");
  return value.trim() || null;
}

export async function saveProfile(body: Record<string, unknown>) {
  const name = optionalText(body.name, 80);
  const path = optionalText(body.path, 500);
  if (!name) throw new ValidationError("Dê um nome ao perfil.", "name");
  if (!path) throw new ValidationError("Diga a pasta do projeto.", "path");
  const script = optionalText(body.script, 100);
  const cmd = optionalText(body.cmd, 500);
  if (!script && !cmd) throw new ValidationError("Diga o script ou o comando.", "script");
  const port = body.port === undefined || body.port === null ? null : Number(body.port);
  if (port !== null && (!Number.isInteger(port) || port < 1024 || port > 65535))
    throw new ValidationError("Porta inválida.", "port");
  await resolveProject({ path, cwd: optionalText(body.cwd, 300) ?? undefined });
  const profiles = await listProfiles();
  const id = optionalText(body.id, 60) ?? slug(name);
  const profile: ServerProfile = { id, name, path, cwd: optionalText(body.cwd, 300) ?? "", script, cmd, port };
  const next = [...profiles.filter((item) => item.id !== id), profile].sort((a, b) => a.name.localeCompare(b.name));
  await writeSetting(profilesKey, next);
  return profile;
}

export async function deleteProfile(id: string) {
  const profiles = await listProfiles();
  const next = profiles.filter((item) => item.id !== id);
  if (next.length === profiles.length) return false;
  await writeSetting(profilesKey, next);
  return true;
}

export async function findProfile(ref: string) {
  const wanted = ref.trim().toLowerCase();
  const profiles = await listProfiles();
  return profiles.find((item) => item.id === wanted || item.name.toLowerCase() === wanted) ?? null;
}

export interface StartInput {
  path?: string;
  project?: string;
  branch?: string;
  cwd?: string;
  script?: string;
  cmd?: string;
  profile?: string;
  port?: number;
  startedBy: "bot" | "user";
  botId?: string | null;
  sessionId?: string | null;
}

export async function describeProject(input: { path?: string; project?: string; branch?: string; cwd?: string }) {
  const project = await resolveProject(input);
  const { manager, scripts } = await readScripts(project);
  const env = await loadEnv(project);
  return {
    name: project.name,
    path: project.path,
    repoPath: project.repoPath,
    branch: project.branch,
    cwd: project.cwd,
    manager,
    scripts: scripts.map((item) => ({ ...item, tool: toolOf(item.command) })),
    envFiles: env.files,
    envKeys: env.keys,
  };
}

export async function startProjectServer(input: StartInput, onExit?: (server: PublicDevServer) => void) {
  let spec = { ...input };
  let profileId: string | null = null;
  if (input.profile) {
    const profile = await findProfile(input.profile);
    if (!profile) throw new ValidationError(`Não achei o perfil ${input.profile}.`, "profile");
    profileId = profile.id;
    spec = {
      ...spec,
      path: profile.path,
      cwd: spec.cwd ?? profile.cwd,
      script: spec.script ?? profile.script ?? undefined,
      cmd: spec.cmd ?? profile.cmd ?? undefined,
      port: spec.port ?? profile.port ?? undefined,
    };
  }
  const project = await resolveProject(spec);
  const { manager, scripts } = await readScripts(project);
  let cmd = spec.cmd?.trim() ?? "";
  let scriptBody: string | null = null;
  if (!cmd && spec.script) {
    const script = scripts.find((item) => item.name === spec.script);
    if (!script) throw new ValidationError(`O package.json não tem o script ${spec.script}.`, "script");
    cmd = scriptCommand(manager, script.name);
    scriptBody = script.command;
  }
  if (!cmd) throw new ValidationError("Diga o script ou o comando.", "script");
  const env = await loadEnv(project);
  await linkEnvFiles(project);
  const { server, ready } = await launchServer(
    {
      key: projectKey(project.path),
      kind: "project",
      path: project.path,
      name: project.name,
      branch: project.branch,
    },
    {
      cmd,
      cwd: project.cwd,
      env: env.values,
      envKeys: env.keys,
      secrets: env.secrets,
      tool: toolOf(scriptBody, cmd),
      script: spec.script ?? null,
      profileId,
      startedBy: input.startedBy,
      botId: input.botId ?? null,
      sessionId: input.sessionId ?? null,
      ...(spec.port ? { port: spec.port } : {}),
    },
    onExit,
  );
  return { server: viewServer(server), ready };
}

export function requireServer(id: string): DevServer {
  const server = getServer(id);
  if (!server) throw new ValidationError("Esse servidor não existe mais.", "id");
  return server;
}

export async function stopServer(id: string) {
  return stopDevServer(requireServer(id));
}

export async function restart(id: string) {
  const { server, ready } = await restartServer(requireServer(id));
  return { server: viewServer(server), ready };
}

export function forget(id: string) {
  const server = requireServer(id);
  if (!forgetServer(server)) throw new ValidationError("Pare o servidor antes de remover.", "id");
  return true;
}
