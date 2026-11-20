import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { promises as dns } from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ValidationError } from "../errors";
import { guardedFetch, isPublicAddress, resolvePublic } from "../net-guard";

type LookupAnswer = { address: string; family: number };

function fakeDns(answers: LookupAnswer[] | Error) {
  return spyOn(dns, "lookup").mockImplementation((() =>
    answers instanceof Error ? Promise.reject(answers) : Promise.resolve(answers)) as unknown as typeof dns.lookup);
}

const spies: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("isPublicAddress", () => {
  test("accepts global unicast v4 and v6", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "[2a00:1450::1]"])
      expect(isPublicAddress(ip)).toBe(true);
  });

  test("rejects every reserved v4 range", () => {
    for (const ip of [
      "0.1.2.3",
      "10.0.0.1",
      "100.64.0.1",
      "100.127.255.254",
      "127.0.0.1",
      "127.9.9.9",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.8",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "239.255.255.255",
      "240.0.0.1",
      "255.255.255.255",
    ])
      expect(isPublicAddress(ip)).toBe(false);
  });

  test("rejects reserved v6 ranges and unwraps embedded v4", () => {
    for (const ip of [
      "::",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "fe80::1%eth0",
      "ff02::1",
      "2001:db8::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b::192.168.0.1",
      "2002:7f00:1::1",
      "2002:c0a8:0101::1",
      "::127.0.0.1",
      "100::1",
      "not-an-ip",
      "1:2:3",
      "zz::1",
    ])
      expect(isPublicAddress(ip)).toBe(false);
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicAddress("64:ff9b::808:808")).toBe(true);
    expect(isPublicAddress("2002:0808:0808::1")).toBe(true);
  });
});

describe("resolvePublic", () => {
  test("rejects bad schemes, userinfo, single labels and internal suffixes", async () => {
    for (const raw of [
      "ftp://example.com/",
      "file:///etc/passwd",
      "https://user:pw@example.com/",
      "https://user@example.com/",
      "http://intranet/",
      "http://localhost:80/",
      "https://box.tail1234.ts.net/",
      "https://metadata.google.internal/",
      "http://printer.local/",
      "http://a.localhost/",
      "http://[::ffff:127.0.0.1]/",
      "http://169.254.169.254/latest/meta-data",
      "http://100.100.100.100/",
    ])
      await expect(resolvePublic(new URL(raw))).rejects.toBeInstanceOf(ValidationError);
  });

  test("returns a literal public address without DNS", async () => {
    const lookup = fakeDns([]);
    spies.push(lookup);
    expect(await resolvePublic(new URL("https://8.8.8.8/"))).toEqual({ address: "8.8.8.8", family: 4 });
    expect(await resolvePublic(new URL("https://[2606:4700:4700::1111]/"))).toEqual({
      address: "2606:4700:4700::1111",
      family: 6,
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  test("checks every DNS answer and rejects a name that points inside", async () => {
    spies.push(fakeDns([{ address: "93.184.215.14", family: 4 }]));
    expect(await resolvePublic(new URL("https://example.com./x"))).toEqual({ address: "93.184.215.14", family: 4 });
    spies.splice(0).forEach((spy) => {
      spy.mockRestore();
    });
    spies.push(
      fakeDns([
        { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 },
        { address: "127.0.0.1", family: 4 },
      ]),
    );
    await expect(resolvePublic(new URL("https://rebind.example.com/"))).rejects.toThrow("endereço interno");
  });

  test("returns the v6 family from DNS", async () => {
    spies.push(fakeDns([{ address: "2606:4700:4700::1111", family: 6 }]));
    expect(await resolvePublic(new URL("http://v6.example.com/"))).toEqual({
      address: "2606:4700:4700::1111",
      family: 6,
    });
  });

  test("fails on a lookup error or an empty answer", async () => {
    spies.push(fakeDns(new Error("ENOTFOUND")));
    await expect(resolvePublic(new URL("https://missing.example.com/"))).rejects.toThrow("Não consegui encontrar");
    spies.splice(0).forEach((spy) => {
      spy.mockRestore();
    });
    spies.push(fakeDns([]));
    await expect(resolvePublic(new URL("https://empty.example.com/"))).rejects.toThrow("Não consegui encontrar");
  });

  test("allows loopback only on an allowed port", async () => {
    expect(await resolvePublic(new URL("http://127.0.0.1:4321/"), { allowLoopbackPorts: [4321] })).toEqual({
      address: "127.0.0.1",
      family: 4,
    });
    expect(await resolvePublic(new URL("http://[::1]:4321/"), { allowLoopbackPorts: [4321] })).toEqual({
      address: "::1",
      family: 6,
    });
    await expect(resolvePublic(new URL("http://127.0.0.1:4322/"), { allowLoopbackPorts: [4321] })).rejects.toThrow(
      "interno",
    );
    await expect(resolvePublic(new URL("http://10.0.0.1:4321/"), { allowLoopbackPorts: [4321] })).rejects.toThrow(
      "interno",
    );
    await expect(resolvePublic(new URL("https://127.0.0.1/"), { allowLoopbackPorts: [80] })).rejects.toThrow("interno");
    expect(await resolvePublic(new URL("http://127.0.0.1/"), { allowLoopbackPorts: [80] })).toEqual({
      address: "127.0.0.1",
      family: 4,
    });
  });
});

describe("guardedFetch", () => {
  let server: http.Server;
  let port = 0;
  const seen: { host?: string; method?: string; body: string }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        seen.push({ host: req.headers.host, method: req.method, body });
        if (req.url === "/redirect") {
          res.writeHead(302, { location: "http://169.254.169.254/" });
          return res.end();
        }
        if (req.url === "/empty") {
          res.writeHead(204);
          return res.end();
        }
        if (req.url === "/big") {
          res.writeHead(200);
          return res.end("x".repeat(4096));
        }
        if (req.url === "/odd") {
          res.writeHead(999);
          return res.end("odd");
        }
        if (req.url === "/slow") return;
        res.writeHead(200, { "content-type": "text/plain", "set-cookie": ["a=1", "b=2"], "x-echo": req.url ?? "" });
        res.end(`ok ${req.method} ${body}`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("refuses loopback unless the port is allowed", async () => {
    await expect(guardedFetch(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(ValidationError);
    await expect(guardedFetch("not a url")).rejects.toThrow("Endereço inválido");
  });

  test("sends method, headers and body and returns a WHATWG Response", async () => {
    const response = await guardedFetch(new URL(`http://127.0.0.1:${port}/echo?q=1`), {
      method: "post",
      headers: { "x-test": "1" },
      body: "hello",
      allowLoopbackPorts: [port],
    });
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-echo")).toBe("/echo?q=1");
    expect(response.headers.get("set-cookie")).toContain("a=1");
    expect(await response.text()).toBe("ok POST hello");
    const binary = await guardedFetch(`http://127.0.0.1:${port}/bin`, {
      method: "PUT",
      body: new Uint8Array([104, 105]),
      allowLoopbackPorts: [port],
    });
    expect(await binary.text()).toBe("ok PUT hi");
  });

  test("pins the checked address while keeping the Host header", async () => {
    spies.push(fakeDns([{ address: "127.0.0.1", family: 4 }]));
    const response = await guardedFetch(`http://api.example.com:${port}/pinned`, { allowLoopbackPorts: [port] });
    expect(await response.text()).toBe("ok GET ");
    expect(seen.at(-1)?.host).toBe(`api.example.com:${port}`);
  });

  test("never follows redirects", async () => {
    const response = await guardedFetch(`http://127.0.0.1:${port}/redirect`, { allowLoopbackPorts: [port] });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://169.254.169.254/");
  });

  test("returns a null body for 204", async () => {
    const response = await guardedFetch(`http://127.0.0.1:${port}/empty`, { allowLoopbackPorts: [port] });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("caps the response size", async () => {
    await expect(
      guardedFetch(`http://127.0.0.1:${port}/big`, { allowLoopbackPorts: [port], maxBytes: 100 }),
    ).rejects.toThrow("limite");
  });

  test("rejects a status a Response cannot carry", async () => {
    await expect(guardedFetch(`http://127.0.0.1:${port}/odd`, { allowLoopbackPorts: [port] })).rejects.toThrow();
  });

  test("times out and honors an aborted signal", async () => {
    await expect(
      guardedFetch(`http://127.0.0.1:${port}/slow`, { allowLoopbackPorts: [port], timeoutMs: 50 }),
    ).rejects.toThrow("cancelada");
    const controller = new AbortController();
    controller.abort();
    await expect(
      guardedFetch(`http://127.0.0.1:${port}/echo`, { allowLoopbackPorts: [port], signal: controller.signal }),
    ).rejects.toThrow("cancelada");
  });

  test("uses TLS for https", async () => {
    await expect(
      guardedFetch(`https://127.0.0.1:${port}/`, { allowLoopbackPorts: [port], timeoutMs: 2000 }),
    ).rejects.toThrow();
  });
});
