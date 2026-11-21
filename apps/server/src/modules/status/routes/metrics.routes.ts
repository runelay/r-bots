import type { Res } from "../../../shared/http";
import { metricsContentType } from "../constants/metrics.constants";
import { metricsText } from "../services/metrics.service";

export async function handleMetrics(res: Res) {
  const body = await metricsText();
  res.writeHead(200, { "content-type": metricsContentType, "cache-control": "no-store" });
  res.end(body);
}
