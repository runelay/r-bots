import { defaultRegistry, pullProgressSteps, registryAuthUser } from "./constants";
import { type DockerApi, DockerError } from "./docker-api";
import { isRecord, stringOf } from "./json";
import type { ImageRef, RegistryCredentials } from "./types";

export function parseImageRef(image: string): ImageRef {
  const at = image.indexOf("@");
  const name = at >= 0 ? image.slice(0, at) : image;
  const slash = name.lastIndexOf("/");
  const colon = name.lastIndexOf(":");
  const tagged = colon > slash;
  const repository = tagged ? name.slice(0, colon) : name;
  const tag = at >= 0 ? image.slice(at + 1) : tagged ? name.slice(colon + 1) : "latest";
  const first = repository.split("/")[0] ?? "";
  const hosted = repository.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  return { repository, tag, registry: hosted ? first : defaultRegistry };
}

export function registryAuth(credentials: RegistryCredentials, registry: string) {
  if (!credentials.token) return null;
  const payload = {
    username: credentials.user || registryAuthUser,
    password: credentials.token,
    serveraddress: registry,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}

function pullHint(message: string, authenticated: boolean) {
  const denied = /denied|unauthorized|authentication required|403|401/i.test(message);
  if (!denied) return "";
  return authenticated
    ? " Confira se RBOTS_REGISTRY_TOKEN pode ler pacotes desse registry."
    : " O registry pediu login: passe RBOTS_REGISTRY_USER e RBOTS_REGISTRY_TOKEN ao runner.";
}

class PullProgress {
  private readonly layers = new Map<string, { current: number; total: number }>();
  private step = 0;

  constructor(
    private readonly image: string,
    private readonly log: (line: string) => void,
  ) {}

  push(line: unknown) {
    if (!isRecord(line)) return;
    if (typeof line.error === "string") throw new Error(line.error);
    const id = stringOf(line.id);
    const detail = isRecord(line.progressDetail) ? line.progressDetail : {};
    const { current, total } = detail;
    if (id && line.status === "Downloading" && typeof current === "number" && typeof total === "number")
      this.layers.set(id, { current, total });
    if (id && line.status === "Download complete") {
      const layer = this.layers.get(id);
      if (layer) layer.current = layer.total;
    }
    this.report();
  }

  private report() {
    const layers = [...this.layers.values()];
    const total = layers.reduce((sum, layer) => sum + layer.total, 0);
    if (total === 0) return;
    const done = layers.reduce((sum, layer) => sum + layer.current, 0);
    const step = Math.floor((done / total) * pullProgressSteps);
    if (step <= this.step) return;
    this.step = step;
    const megabytes = Math.round(total / 1024 / 1024);
    this.log(`baixando ${this.image}: ${Math.round((step / pullProgressSteps) * 100)}% de ${megabytes} MB`);
  }
}

export class BoxImage {
  private pulling: Promise<string> | null = null;
  readonly ref: ImageRef;

  constructor(
    private readonly api: DockerApi,
    readonly image: string,
    private readonly auth: string | null,
    private readonly log: (line: string) => void,
  ) {
    this.ref = parseImageRef(image);
  }

  async current() {
    const { status, body } = await this.api.request("GET", `/images/${encodeURIComponent(this.image)}/json`);
    if (status === 404) return null;
    if (status !== 200 || !isRecord(body)) throw new DockerError(`GET /images/${this.image}/json: ${status}`, status);
    return stringOf(body.Id) || null;
  }

  async ensure() {
    const id = await this.current();
    if (id) return id;
    this.pulling ??= this.pull().finally(() => {
      this.pulling = null;
    });
    return this.pulling;
  }

  private async pull() {
    const { repository, tag, registry } = this.ref;
    const query = new URLSearchParams({ fromImage: repository, tag });
    const headers: Record<string, string> = this.auth ? { "X-Registry-Auth": this.auth } : {};
    const progress = new PullProgress(this.image, this.log);
    this.log(`imagem da caixa ${this.image} não existe aqui; baixando de ${registry}`);
    try {
      await this.api.stream("POST", `/images/create?${query}`, headers, (line) => progress.push(line));
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
      throw new Error(
        `Não consegui baixar a imagem da caixa ${this.image}: ${message}.${pullHint(message, this.auth !== null)}`,
      );
    }
    const id = await this.current();
    if (!id)
      throw new Error(`Não consegui baixar a imagem da caixa ${this.image}: o Docker não a encontrou depois do pull.`);
    this.log(`imagem da caixa ${this.image} baixada (${id.slice(0, 19)})`);
    return id;
  }
}
