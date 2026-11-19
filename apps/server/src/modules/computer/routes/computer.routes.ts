import { type Res, sendJson } from "../../../shared/http";
import { computerHealth } from "../services/computer.service";

export async function handleComputerHealth(res: Res) {
  return sendJson(res, 200, await computerHealth());
}
