import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fakeProcesses, type ProcessCall, type ProcessReply, resetData, testDataDir } from "../../../../test/helpers";
import { mediaTools } from "../../../../test/media-helpers";
import { rootDir } from "../../../config/env";
import { getDb, tables } from "../../../db";
import { outboxDir } from "../../uploads/services/send-file.service";
import { fileEventOf, importBotFile, uploadGuide, uploadTools } from "../../uploads/services/uploads.service";
import { cutoutScript } from "../services/cutout.service";

const botId = "cutout-bot";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const stats = { width: 640, height: 480, partialEdgePixels: 900, opaquePixels: 1000, islands: 1 };

let calls: ProcessCall[] = [];
let reply: (call: ProcessCall) => ProcessReply = (call) => {
  writeFileSync(call.args[3] as string, png);
  return { stdout: `loading\n${JSON.stringify(stats)}\n` };
};

const tool = () => {
  const found = uploadTools(botId).find((item) => item.name === "image_cutout");
  if (!found) throw new Error("image_cutout missing");
  return found;
};

function writeImage(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png);
  return path;
}

const signal = new AbortController().signal;

beforeEach(async () => {
  await resetData();
  await getDb().delete(tables.uploads);
  process.env.IMAGE_CUTOUT_PYTHON = "/fake/python";
  calls = [];
  const media = mediaTools();
  fakeProcesses((call) => {
    if (call.command !== "/fake/python") return media.handler(call);
    calls.push(call);
    return reply(call);
  });
});

afterEach(() => {
  delete process.env.IMAGE_CUTOUT_PYTHON;
  reply = (call) => {
    writeFileSync(call.args[3] as string, png);
    return { stdout: `loading\n${JSON.stringify(stats)}\n` };
  };
});

describe("image_cutout", () => {
  test("cuts an outbox image next to it, trims on request and posts it without approval", async () => {
    const source = writeImage(join(outboxDir(botId), "icones", "foguete.png"));
    const cutout = tool();
    expect(cutout.approval).toBeNull();
    expect(cutout.description).toContain(outboxDir(botId));
    expect(cutout.label({ path: source })).toBe("Recortar o fundo de foguete.png");
    expect(cutout.label({})).toBe("Recortar o fundo de imagem");
    const output = (await cutout.run({ path: source, trim: true }, signal)) as Record<string, unknown>;
    const target = join(outboxDir(botId), "icones", "foguete-recorte.png");
    expect(output).toMatchObject({ name: "foguete-recorte.png", path: target, width: 640, height: 480 });
    expect(existsSync(target)).toBe(true);
    expect(existsSync(`${target}.part.png`)).toBe(false);
    expect(fileEventOf(output)?.data.attachment).toMatchObject({ name: "foguete-recorte.png", source: "bot" });
    expect(calls[0]?.command).toBe("/fake/python");
    expect(calls[0]?.args).toEqual(["-I", cutoutScript(), source, `${target}.part.png`, "--trim"]);
    expect(cutoutScript()).toBe(join(rootDir, "bin", "image-cutout.py"));
  });

  test("reads a conversation attachment by uploadId and writes into outbox/imagens", async () => {
    const meta = await importBotFile(botId, writeImage(join(outboxDir(botId), "foto.jpg")), "produto.png");
    const output = (await tool().run({ uploadId: meta.uploadId }, signal)) as Record<string, unknown>;
    expect(output.path).toBe(join(outboxDir(botId), "imagens", "produto-recorte.png"));
    expect(calls[0]?.args).not.toContain("--trim");
  });

  test("reads the path image_gen returned and names it like the generated attachment", async () => {
    const source = writeImage(join(testDataDir(), "codex-home", "generated_images", "th-1", "exec-0123abcd-ffff.png"));
    const output = (await tool().run({ path: source }, signal)) as Record<string, unknown>;
    expect(output.name).toBe("imagem-0123abcd-recorte.png");
    expect(output.path).toBe(join(outboxDir(botId), "imagens", "imagem-0123abcd-recorte.png"));
  });

  test("refuses missing input, other formats, paths outside the outbox and unknown files", async () => {
    const run = (input: Record<string, unknown>) => tool().run(input, signal);
    await expect(run({})).rejects.toThrow("Mande o caminho da imagem ou o uploadId do anexo.");
    await expect(run({ path: "  " })).rejects.toThrow("Mande o caminho");
    await expect(run({ path: join(outboxDir(botId), "a.txt") })).rejects.toThrow("O recorte aceita PNG, JPEG ou WebP.");
    await expect(run({ path: "/etc/passwd.png" })).rejects.toThrow("só lê imagens da sua pasta de saída");
    await expect(run({ path: join(outboxDir(botId), "nada.png") })).rejects.toThrow("Não achei");
    await expect(run({ path: "/nowhere/generated_images/th/exec-1.png" })).rejects.toThrow("Não achei");
    await expect(run({ uploadId: "01JNOTREAL0000000000000000" })).rejects.toThrow("Anexo de imagem não encontrado.");
    mkdirSync(outboxDir(botId), { recursive: true });
    writeFileSync(join(outboxDir(botId), "nota.txt"), "texto simples");
    const text = await importBotFile(botId, join(outboxDir(botId), "nota.txt"));
    await expect(run({ uploadId: text.uploadId })).rejects.toThrow("Anexo de imagem não encontrado.");
    expect(calls).toHaveLength(0);
  });

  test("reports the python failure and leaves no partial file behind", async () => {
    const source = writeImage(join(outboxDir(botId), "quebrada.png"));
    reply = (call) => {
      writeFileSync(call.args[3] as string, "meio");
      return { code: 1, stderr: "Traceback\nimagem corrompida\n" };
    };
    await expect(tool().run({ path: source }, signal)).rejects.toThrow(
      "Não consegui recortar a imagem: imagem corrompida",
    );
    await Bun.sleep(5);
    expect(existsSync(join(outboxDir(botId), "quebrada-recorte.png.part.png"))).toBe(false);
    reply = () => ({ code: 2 });
    await expect(tool().run({ path: source }, signal)).rejects.toThrow("Não consegui recortar a imagem: código 2");
    reply = (call) => {
      writeFileSync(call.args[3] as string, png);
      return {};
    };
    const output = (await tool().run({ path: source }, signal)) as Record<string, unknown>;
    expect(output.width).toBeUndefined();
  });

  test("the guide asks for a flat contrasting background and image_cutout", () => {
    expect(uploadGuide).toContain("image_cutout");
    expect(uploadGuide).toContain("1024 px");
  });
});
