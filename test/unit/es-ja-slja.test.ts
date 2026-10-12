import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSlja } from "../../scripts/lib/es-ja-slja.js";

async function zip(entries: Record<string, Buffer>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "slja-"));
  for (const [name, content] of Object.entries(entries)) {
    await writeFile(path.join(dir, name), content);
  }
  execFileSync("zip", ["-q", "-r", "archive.slja", "."], { cwd: dir });
  return path.join(dir, "archive.slja");
}

describe("SLJA parser", () => {
  it("lê slides.lja Windows-1252 e converte slides", async () => {
    const file = await zip({
      "slides.lja": Buffer.from(
        "[Geral]\r\nslides=1\r\ntitulo=Canci\u00f3n\r\n[Slide:1]\r\nletra=Ol\u00e1|mundo\r\ntempo=00:01:02\r\n",
        "latin1",
      ),
    });
    await expect(parseSlja(file)).resolves.toMatchObject({
      title: "Canción",
      slides: [{ lyric: "Olá\nmundo", time: "00:01:02", order: 1 }],
    });
  });

  it("lê tempo pela chave real 'tempo' (não tempo_hms)", async () => {
    const file = await zip({
      "slides.lja": Buffer.from(
        "[Geral]\r\nslides=2\r\n[Slide:1]\r\nletra=A\r\ntempo=00:00:18\r\n[Slide:2]\r\nletra=B\r\ntempo=00:00:23\r\n",
        "latin1",
      ),
    });
    await expect(parseSlja(file)).resolves.toMatchObject({
      slides: [
        { time: "00:00:18", order: 1 },
        { time: "00:00:23", order: 2 },
      ],
    });
  });

  it("lê imagem com caminho Windows (imagens\\hasd.jpg) e posição", async () => {
    const file = await zip({
      "slides.lja": Buffer.from(
        "[Geral]\r\nslides=1\r\n[Slide:1]\r\nletra=A\r\nimagem=imagens\\hasd_297B.jpg\r\nimagem_posicao=5\r\n",
        "latin1",
      ),
    });
    await expect(parseSlja(file)).resolves.toMatchObject({
      slides: [{ imageName: "hasd_297B.jpg", imagePosition: 5 }],
    });
  });

  it("rejeita ZIP sem slides.lja", async () => {
    await expect(
      parseSlja(await zip({ "other.txt": Buffer.from("x") })),
    ).rejects.toThrow("slides.lja");
  });

  it("rejeita path traversal no ZIP", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "slja-slip-"));
    const file = path.join(dir, "slip.slja");
    execFileSync("python3", [
      "-c",
      "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('../evil','x'); z.writestr('slides.lja','[Geral]\\nslides=0'); z.close()",
      file,
    ]);
    await expect(parseSlja(file)).rejects.toThrow();
  });

  it("lê slides.lja com nomes de entrada em barra invertida (Windows)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "slja-win-"));
    const file = path.join(dir, "win.slja");
    execFileSync("python3", [
      "-c",
      "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('audio\\\\x.mp3','a'); z.writestr('slides.lja','[Geral]\\nslides=0'); z.close()",
      file,
    ]);
    await expect(parseSlja(file)).resolves.toMatchObject({
      title: "Sin título",
      slides: [],
    });
  });

  it("rejeita ZIP acima do limite de bytes descomprimidos", async () => {
    const file = await zip({ "slides.lja": Buffer.from("[Geral]\nslides=0") });
    await expect(parseSlja(file, 1)).rejects.toThrow("size limit");
  });
});
