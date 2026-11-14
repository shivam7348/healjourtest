// One place to record what happened with external systems, in words a staff member can read.
// Never throws: a logging failure must not break the booking or sync that it describes.

import { randomBytes } from "node:crypto";
import type { IntegrationLog } from "./models.js";
import { getStore } from "./store.js";

export type LogInput = Omit<IntegrationLog, "id" | "at">;

export async function logIntegration(entry: LogInput) {
  try {
    await getStore().appendIntegrationLog({
      id: `log-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      at: new Date().toISOString(),
      ...entry
    });
  } catch (error) {
    console.warn("Could not write integration log:", error instanceof Error ? error.message : error);
  }
}
