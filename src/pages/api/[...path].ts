// Every /api/* request is handled by the existing Express app (server/app.ts).
// Pages Router API routes give us Node's req/res, which Express understands directly.
import type { NextApiRequest, NextApiResponse } from "next";
import { app, ensureReady } from "../../../server/app";

export const config = {
  api: {
    bodyParser: false, // Express parses JSON itself
    externalResolver: true // Express sends the response
  }
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await ensureReady();
  return app(req, res);
}
