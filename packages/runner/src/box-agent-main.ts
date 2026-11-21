import { runTurn } from "@runelay-bots/providers";
import { runBoxAgent } from "./box-agent";
import { realClock } from "./clock";
import { boxDataDir, hookTimeoutMs } from "./constants";

const writer = Bun.stdout.writer();
const code = await runBoxAgent({
  input: Bun.stdin.stream(),
  write: (text) => {
    writer.write(text);
    writer.flush();
  },
  runTurn,
  dataDir: boxDataDir,
  hookTimeoutMs,
  clock: realClock,
});
await writer.flush();
process.exit(code);
