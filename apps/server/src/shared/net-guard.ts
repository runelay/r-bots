import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { ValidationError } from "./errors";
import { defineMessages } from "./i18n";

const netText = defineMessages({
  "pt-BR": {
    httpOnly: "Só endereços http ou https são permitidos.",
    credentials: "O endereço não pode ter usuário ou senha embutidos.",
    internalAddress: "O endereço {host} é interno e não é permitido.",
    notPublic: "O site {host} não é um endereço público.",
    empty: "(vazio)",
    internalNetwork: "O site {host} é de uma rede interna e não é permitido.",
    notFound: "Não consegui encontrar o site {host}.",
    pointsInternal: "O site {host} aponta para um endereço interno ({address}) e não é permitido.",
    invalid: "Endereço inválido.",
    tooLarge: "A resposta passou do limite de {max} bytes.",
    timeout: "A chamada demorou demais ou foi cancelada.",
  },
  en: {
    httpOnly: "Only http or https addresses are allowed.",
    credentials: "The address can't carry a user name or password.",
    internalAddress: "The address {host} is internal and not allowed.",
    notPublic: "The site {host} is not a public address.",
    empty: "(empty)",
    internalNetwork: "The site {host} is on an internal network and not allowed.",
    notFound: "Couldn't find the site {host}.",
    pointsInternal: "The site {host} points to an internal address ({address}) and is not allowed.",
    invalid: "Invalid address.",
    tooLarge: "The response went over the {max} byte limit.",
    timeout: "The call took too long or was canceled.",
  },
});

const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blockedV4.addSubnet(network, prefix, "ipv4");

const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["2001::", 32],
  ["2001::", 23],
] as const)
  blockedV6.addSubnet(network, prefix, "ipv6");

function v6Bytes(address: string): number[] | null {
  let text = address;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const maybeV4 = text.slice(lastColon + 1);
  if (isIP(maybeV4) === 4) {
    const octets = maybeV4.split(".").map(Number);
    tail.push(((octets[0] << 8) | octets[1]) >>> 0, ((octets[2] << 8) | octets[3]) >>> 0);
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  const groups = [...head, ...Array(Math.max(0, missing)).fill("0"), ...rest].map((group) =>
    Number.parseInt(group, 16),
  );
  if (groups.length !== 8 || groups.some((group) => Number.isNaN(group))) return null;
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

function v4Of(bytes: number[], offset: number) {
  return bytes.slice(offset, offset + 4).join(".");
}

const mappedPrefix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];
const nat64Prefix = [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0];

function startsWith(bytes: number[], prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value);
}

function embeddedV4(bytes: number[]) {
  if (startsWith(bytes, mappedPrefix) || startsWith(bytes, nat64Prefix)) return v4Of(bytes, 12);
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return v4Of(bytes, 2);
  return null;
}

export function isPublicAddress(ip: string): boolean {
  const address = ip.trim().replace(/^\[|\]$/g, "");
  const family = isIP(address);
  if (family === 4) return address !== "255.255.255.255" && !blockedV4.check(address, "ipv4");
  if (family !== 6 || address.includes("%")) return false;
  const bytes = v6Bytes(address.toLowerCase());
  if (!bytes) return false;
  const inner = embeddedV4(bytes);
  if (inner !== null) return isPublicAddress(inner);
  if ((bytes[0] & 0xe0) !== 0x20) return false;
  return !blockedV6.check(address, "ipv6");
}

const blockedSuffixes = [".ts.net", ".internal", ".local", ".localhost", ".localdomain", ".home.arpa", ".onion"];

function denied(message: string): never {
  throw new ValidationError(message, "url");
}

function portOf(url: URL) {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export async function resolvePublic(url: URL, opts: { allowLoopbackPorts?: number[] } = {}): Promise<ResolvedAddress> {
  if (url.protocol !== "http:" && url.protocol !== "https:") denied(netText("httpOnly"));
  if (url.username || url.password) denied(netText("credentials"));
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  const loopbackAllowed = (opts.allowLoopbackPorts ?? []).includes(portOf(url));
  const loopback = (address: string) => loopbackAllowed && (address === "127.0.0.1" || address === "::1");
  const literal = isIP(host);
  if (literal) {
    if (!isPublicAddress(host) && !loopback(host)) denied(netText("internalAddress", { host }));
    return { address: host, family: literal === 6 ? 6 : 4 };
  }
  if (!host.includes(".")) denied(netText("notPublic", { host: host || netText("empty") }));
  if (blockedSuffixes.some((suffix) => host.endsWith(suffix))) denied(netText("internalNetwork", { host }));
  let answers: { address: string; family: number }[];
  try {
    answers = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    denied(netText("notFound", { host }));
  }
  if (answers.length === 0) denied(netText("notFound", { host }));
  const internal = answers.find((answer) => !isPublicAddress(answer.address) && !loopback(answer.address));
  if (internal) denied(netText("pointsInternal", { host, address: internal.address }));
  const first = answers[0];
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

type GuardedInit = RequestInit & { allowLoopbackPorts?: number[]; maxBytes?: number; timeoutMs?: number };

const nullBodyStatuses = new Set([101, 103, 204, 205, 304]);

async function bodyBytes(body: RequestInit["body"]) {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  return Buffer.from(await new Response(body).arrayBuffer());
}

export async function guardedFetch(target: URL | string, init: GuardedInit = {}): Promise<Response> {
  let url: URL;
  try {
    url = typeof target === "string" ? new URL(target) : target;
  } catch {
    denied(netText("invalid"));
  }
  const pinned = await resolvePublic(url, { allowLoopbackPorts: init.allowLoopbackPorts });
  const maxBytes = init.maxBytes ?? 10 * 1024 * 1024;
  const timeoutMs = init.timeoutMs ?? 30_000;
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });
  const payload = await bodyBytes(init.body);
  if (payload) headers["content-length"] = String(payload.length);
  const lookup: LookupFunction = (_host, options, callback) => {
    if (options.all) callback(null, [pinned]);
    else callback(null, pinned.address, pinned.family);
  };
  const client = url.protocol === "https:" ? https : http;
  return await new Promise<Response>((resolve, reject) => {
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(init.signal ? [init.signal] : [])]);
    const request = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: portOf(url),
        path: `${url.pathname}${url.search}`,
        method: (init.method ?? "GET").toUpperCase(),
        headers,
        lookup,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            reject(new Error(netText("tooLarge", { max: maxBytes })));
            response.destroy();
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          if (size > maxBytes) return;
          const out = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            for (const item of Array.isArray(value) ? value : [value]) out.append(key, item);
          }
          const status = response.statusCode ?? 502;
          try {
            resolve(
              new Response(nullBodyStatuses.has(status) ? null : Buffer.concat(chunks), {
                status,
                statusText: response.statusMessage ?? "",
                headers: out,
              }),
            );
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    const abort = () => request.destroy(new Error(netText("timeout")));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    request.on("error", reject);
    request.on("close", () => signal.removeEventListener("abort", abort));
    if (payload) request.write(payload);
    request.end();
  });
}
