// Who is acting on this request: the signed-in user and, during "Login as", the Super Admin behind them.
// Records store it as `creator` (who created them); the audit trail names both people.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Request } from "express";

export type Actor = {
  id: string; name: string; email: string;
  via?: { id: string; name: string; email: string };   // Super Admin who was logged in as this user
};

type Context = { actor?: Actor };
const storage = new AsyncLocalStorage<Context>();

/** Runs the rest of the request with its actor available to deeper code (audit, stamps). */
export const runWithActor = (actor: Actor | undefined, fn: () => void) => storage.run({ actor }, fn);
export const currentActor = (): Actor | undefined => storage.getStore()?.actor;

/** Audit actor text, e.g. "healjour_admin:a@x.in (via Super Admin s@x.in)". */
export function auditActorText(actor: string) {
  const via = currentActor()?.via;
  return via && !actor.includes("(via ") && !actor.includes(via.email) ? `${actor} (via Super Admin ${via.email})` : actor;
}

/** Who created a record, for the `creator` field. */
export function actorOf(req: Request): Actor | undefined {
  return req.actor ?? currentActor();
}

declare module "express-serve-static-core" {
  interface Request { actor?: Actor }
}
