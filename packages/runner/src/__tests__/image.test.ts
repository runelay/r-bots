import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DockerApi } from "../docker-api";
import { BoxImage, parseImageRef, registryAuth } from "../image";
import { FakeDocker } from "./helpers";

let docker: FakeDocker;
let api: DockerApi;

beforeEach(() => {
  docker = new FakeDocker().start();
  api = new DockerApi(docker.socketPath);
});

afterEach(() => docker.stop());

function boxImage(image = "ghcr.io/runelay/r-bots-box:0.2.0", auth: string | null = null) {
  const logs: string[] = [];
  return { image: new BoxImage(api, image, auth, (line) => logs.push(line)), logs };
}

describe("image references", () => {
  test("splits repository, tag or digest and registry", () => {
    expect(parseImageRef("ghcr.io/runelay/r-bots-box:0.2.0")).toEqual({
      repository: "ghcr.io/runelay/r-bots-box",
      tag: "0.2.0",
      registry: "ghcr.io",
    });
    expect(parseImageRef("runelay-bots-box")).toEqual({
      repository: "runelay-bots-box",
      tag: "latest",
      registry: "docker.io",
    });
    expect(parseImageRef("library/node:24")).toMatchObject({ registry: "docker.io", tag: "24" });
    expect(parseImageRef("localhost:5000/box")).toEqual({
      repository: "localhost:5000/box",
      tag: "latest",
      registry: "localhost:5000",
    });
    expect(parseImageRef("localhost/box:1")).toMatchObject({ registry: "localhost" });
    expect(parseImageRef("ghcr.io/r/box:1@sha256:abc")).toEqual({
      repository: "ghcr.io/r/box",
      tag: "sha256:abc",
      registry: "ghcr.io",
    });
  });

  test("builds X-Registry-Auth only when a token exists", () => {
    expect(registryAuth({ user: "octo", token: null }, "ghcr.io")).toBeNull();
    const decode = (value: string | null) => JSON.parse(Buffer.from(value ?? "", "base64url").toString());
    const padded = registryAuth({ user: "o", token: "tt" }, "ghcr.io") ?? "";
    expect(padded.endsWith("=")).toBe(true);
    expect(padded).not.toMatch(/[+/]/);
    expect(decode(registryAuth({ user: "octo", token: "ghp_1" }, "ghcr.io"))).toEqual({
      username: "octo",
      password: "ghp_1",
      serveraddress: "ghcr.io",
    });
    expect(decode(registryAuth({ user: null, token: "ghp_1" }, "docker.io")).username).toBe("rbots");
  });
});

describe("BoxImage", () => {
  test("returns the local id without pulling", async () => {
    const { image, logs } = boxImage();
    expect(await image.ensure()).toBe("sha256:box-current");
    expect(docker.paths()).toEqual(["GET /images/ghcr.io%2Frunelay%2Fr-bots-box%3A0.2.0/json"]);
    expect(logs).toEqual([]);
  });

  test("pulls once with auth, logs progress in steps and returns the new id", async () => {
    docker.imageLabels = null;
    const megabyte = 1024 * 1024;
    docker.pullLines = [
      { status: "Pulling from runelay/r-bots-box", id: "0.2.0" },
      "not json",
      { status: "Pulling fs layer", id: "a" },
      { status: "Downloading", id: "a", progressDetail: { current: 10 * megabyte, total: 100 * megabyte } },
      { status: "Downloading", id: "b", progressDetail: { current: 0, total: 100 * megabyte } },
      { status: "Downloading", id: "a", progressDetail: { current: 60 * megabyte, total: 100 * megabyte } },
      { status: "Downloading", id: "a", progressDetail: { current: 61 * megabyte, total: 100 * megabyte } },
      { status: "Downloading", id: "b", progressDetail: {} },
      { status: "Download complete", id: "a" },
      { status: "Download complete", id: "c" },
      { status: "Download complete", id: "b" },
      { status: "Status: Downloaded newer image for ghcr.io/runelay/r-bots-box:0.2.0" },
    ];
    const { image, logs } = boxImage(undefined, "abc");
    const [first, second] = await Promise.all([image.ensure(), image.ensure()]);
    expect([first, second]).toEqual(["sha256:box-current", "sha256:box-current"]);
    const pulls = docker.requests.filter(({ path }) => path.startsWith("/images/create"));
    expect(pulls).toHaveLength(1);
    expect(pulls[0]?.path).toBe("/images/create?fromImage=ghcr.io%2Frunelay%2Fr-bots-box&tag=0.2.0");
    expect(pulls[0]?.headers["x-registry-auth"]).toBe("abc");
    expect(logs).toEqual([
      "imagem da caixa ghcr.io/runelay/r-bots-box:0.2.0 não existe aqui; baixando de ghcr.io",
      "baixando ghcr.io/runelay/r-bots-box:0.2.0: 10% de 100 MB",
      "baixando ghcr.io/runelay/r-bots-box:0.2.0: 30% de 200 MB",
      "baixando ghcr.io/runelay/r-bots-box:0.2.0: 50% de 200 MB",
      "baixando ghcr.io/runelay/r-bots-box:0.2.0: 100% de 200 MB",
      "imagem da caixa ghcr.io/runelay/r-bots-box:0.2.0 baixada (sha256:box-current)",
    ]);
  });

  test("explains failed pulls with a hint about credentials", async () => {
    docker.imageLabels = null;
    docker.pullStatus = 401;
    await expect(boxImage().image.ensure()).rejects.toThrow(
      "Não consegui baixar a imagem da caixa ghcr.io/runelay/r-bots-box:0.2.0: pull access denied for box. O registry pediu login: passe RBOTS_REGISTRY_USER e RBOTS_REGISTRY_TOKEN ao runner.",
    );
    docker.pullStatus = 200;
    docker.pullLines = [{ status: "Pulling" }, { error: "manifest unknown" }];
    await expect(boxImage().image.ensure()).rejects.toThrow(
      "Não consegui baixar a imagem da caixa ghcr.io/runelay/r-bots-box:0.2.0: manifest unknown.",
    );
    docker.pullLines = [{ error: "unauthorized:\nauthentication  required" }];
    await expect(boxImage(undefined, "abc").image.ensure()).rejects.toThrow(
      "Confira se RBOTS_REGISTRY_TOKEN pode ler pacotes desse registry.",
    );
    docker.overrides.set("POST /images/create", { status: 500 });
    await expect(boxImage().image.ensure()).rejects.toThrow("POST /images/create");
    docker.overrides.set("POST /images/create", { status: 200, raw: "" });
    await expect(boxImage().image.ensure()).rejects.toThrow("o Docker não a encontrou depois do pull.");
  });

  test("raises when the engine cannot inspect the image", async () => {
    docker.overrides.set("GET /images/box%3A1/json", { status: 500 });
    await expect(boxImage("box:1").image.current()).rejects.toThrow("GET /images/box:1/json: 500");
    docker.overrides.set("GET /images/box%3A1/json", { status: 200, body: { Id: 5 } });
    expect(await boxImage("box:1").image.current()).toBeNull();
  });
});
