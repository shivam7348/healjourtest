// The public https address of this deployment (used in webhook URLs and developer docs).
// PUBLIC_BASE_URL wins, except a localhost value on Vercel (a copied local setting): there the
// project's production domain is used instead (Vercel sets VERCEL_PROJECT_PRODUCTION_URL,
// preferring the custom domain such as app.mnkdiagnostic.in).

const isLocal = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(url);

export function publicBaseUrl(): string {
  const configured = (process.env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const onVercel = Boolean(process.env.VERCEL);
  if (configured && !(onVercel && isLocal(configured))) return configured;
  const production = (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim().replace(/\/+$/, "");
  if (onVercel && production) return production.startsWith("http") ? production : `https://${production}`;
  return configured;
}
