import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderCompose } from "./render-compose";

type Compose = { services: Record<string, Record<string, unknown>> };

const compose = `name: sample

x-image: &image \${RBOTS_IMAGE:-ghcr.io/runelay/r-bots:\${RBOTS_VERSION:-dev}}

services:
  server:
    build:
      context: .

      dockerfile: Dockerfile
    image: *image
    environment:
      RBOTS_VERSION: \${RBOTS_VERSION:-}

  # sandbox runner
  runner:
    image: *image
    entrypoint: ["/usr/local/bin/rbots-runner"]
    environment:
      RBOX_IMAGE: \${RBOX_IMAGE:-\${RBOTS_IMAGE:-ghcr.io/runelay/r-bots:\${RBOTS_VERSION:-dev}}}

  tool:
    build: ./tool
    image: postgres:17
`;

const image = (version: string) => `\${RBOTS_IMAGE:-ghcr.io/runelay/r-bots:\${RBOTS_VERSION:-${version}}}`;

describe("renderCompose", () => {
  const rendered = renderCompose(compose, "0.2.0");
  const parsed = Bun.YAML.parse(rendered) as Compose;

  test("removes every build key", () => {
    expect(rendered).not.toContain("build:");
    expect(rendered).not.toContain("dockerfile:");
    for (const service of Object.values(parsed.services)) expect(service.build).toBeUndefined();
  });

  test("pins the version default of the single image in the anchor and in the box image", () => {
    expect(rendered).not.toContain("${RBOTS_VERSION:-dev}");
    expect(rendered).toContain(`x-image: &image ${image("0.2.0")}\n`);
    expect(parsed.services.server?.image).toBe(image("0.2.0"));
    expect(parsed.services.runner?.image).toBe(image("0.2.0"));
    expect((parsed.services.runner?.environment as Record<string, string>).RBOX_IMAGE).toBe(
      `\${RBOX_IMAGE:-${image("0.2.0")}}`,
    );
  });

  test("keeps the rest of the file untouched", () => {
    expect(rendered).toContain("name: sample\n\nx-image:");
    expect(rendered).toContain("      RBOTS_VERSION: ${RBOTS_VERSION:-}\n");
    expect(rendered).toContain("  server:\n    image: *image\n");
    expect(rendered).toContain('\n\n  # sandbox runner\n  runner:\n    image: *image\n    entrypoint: ["/usr/local/bin/rbots-runner"]\n');
    expect(parsed.services.tool?.image).toBe("postgres:17");
    expect(rendered.endsWith("postgres:17\n")).toBe(true);
  });

  test("accepts pre-release versions", () => {
    expect(renderCompose(compose, "0.2.0-beta.1")).toContain("${RBOTS_VERSION:-0.2.0-beta.1}");
  });

  test("rejects invalid versions", () => {
    expect(() => renderCompose(compose, "v0.2.0")).toThrow("invalid version");
    expect(() => renderCompose(compose, "latest")).toThrow("invalid version");
  });

  test("fails when the compose has no dev default", () => {
    expect(() => renderCompose("services:\n  app:\n    image: app:latest\n", "0.2.0")).toThrow("has no");
  });
});

describe("renderCompose on the repo compose.yaml", () => {
  test("renders a release compose where server, runner and box share one pinned image", async () => {
    const source = await Bun.file(join(import.meta.dir, "../../compose.yaml")).text();
    const rendered = renderCompose(source, "9.9.9");
    const parsed = Bun.YAML.parse(rendered) as Compose;
    expect(rendered).not.toContain("${RBOTS_VERSION:-dev}");
    for (const service of Object.values(parsed.services)) expect(service.build).toBeUndefined();
    const references = rendered.match(/ghcr\.io\/runelay\/r-bots[^:\s]*:[^}\s]+\}?/g) ?? [];
    expect(references.length).toBe(2);
    for (const reference of references) expect(reference).toBe("ghcr.io/runelay/r-bots:${RBOTS_VERSION:-9.9.9}");
    const single = "${RBOTS_IMAGE:-${BOTS_IMAGE:-ghcr.io/runelay/r-bots:${RBOTS_VERSION:-9.9.9}}}";
    expect(parsed.services.server?.image).toBe(single);
    expect(parsed.services.runner?.image).toBe(single);
    expect(parsed.services.runner?.entrypoint).toEqual(["/usr/local/bin/rbots-runner"]);
    expect((parsed.services.runner?.environment as Record<string, string>).RBOX_IMAGE).toBe(`\${RBOX_IMAGE:-${single}}`);
  });
});
