import { describe, expect, test } from "bun:test";
import { renderCompose } from "./render-compose";

const compose = `name: sample

services:
  server:
    build:
      context: .
      dockerfile: apps/server/Dockerfile
    image: \${BOTS_IMAGE:-ghcr.io/runelay/r-bots-server:\${RBOTS_VERSION:-dev}}
    environment:
      RBOTS_VERSION: \${RBOTS_VERSION:-}
      RBOX_IMAGE: \${RBOX_IMAGE:-ghcr.io/runelay/r-bots-box:\${RBOTS_VERSION:-dev}}

  # sandbox image
  box-image:
    build:
      context: .

      dockerfile: packages/runner/box/Dockerfile
    image: \${RBOX_IMAGE:-ghcr.io/runelay/r-bots-box:\${RBOTS_VERSION:-dev}}
    profiles: ["sandbox"]

  runner:
    build:
      context: .
      dockerfile: packages/runner/Dockerfile
      args:
        DOCKER_GID: \${DOCKER_GID:-999}
    image: \${BOTS_RUNNER_IMAGE:-ghcr.io/runelay/r-bots-runner:\${RBOTS_VERSION:-dev}}

  tool:
    build: ./tool
    image: postgres:17
`;

describe("renderCompose", () => {
  const rendered = renderCompose(compose, "0.2.0");
  const parsed = Bun.YAML.parse(rendered) as { services: Record<string, Record<string, unknown>> };

  test("removes every build key", () => {
    expect(rendered).not.toContain("build:");
    expect(rendered).not.toContain("dockerfile:");
    expect(rendered).not.toContain("DOCKER_GID");
    for (const service of Object.values(parsed.services)) expect(service.build).toBeUndefined();
  });

  test("pins the version default in images and environment", () => {
    expect(rendered).not.toContain("${RBOTS_VERSION:-dev}");
    expect(parsed.services.server?.image).toBe("${BOTS_IMAGE:-ghcr.io/runelay/r-bots-server:${RBOTS_VERSION:-0.2.0}}");
    expect(parsed.services.runner?.image).toBe(
      "${BOTS_RUNNER_IMAGE:-ghcr.io/runelay/r-bots-runner:${RBOTS_VERSION:-0.2.0}}",
    );
    expect(parsed.services["box-image"]?.image).toBe("${RBOX_IMAGE:-ghcr.io/runelay/r-bots-box:${RBOTS_VERSION:-0.2.0}}");
    expect((parsed.services.server?.environment as Record<string, string>).RBOX_IMAGE).toBe(
      "${RBOX_IMAGE:-ghcr.io/runelay/r-bots-box:${RBOTS_VERSION:-0.2.0}}",
    );
  });

  test("keeps the rest of the file untouched", () => {
    expect(rendered).toContain("name: sample\n\nservices:\n");
    expect(rendered).toContain("      RBOTS_VERSION: ${RBOTS_VERSION:-}\n");
    expect(rendered).toContain("\n\n  # sandbox image\n  box-image:\n    image:");
    expect(rendered).toContain('    profiles: ["sandbox"]\n\n  runner:\n    image:');
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
