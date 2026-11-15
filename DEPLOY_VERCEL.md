# Healjour Integration Studio (Next.js): run and deploy

The UI and the API are one Next.js app.

- `src/app/` holds the page (the studio UI).
- `src/pages/api/[...path].ts` sends every `/api/*` request to the Express app in `server/app.ts`.
- `server/core/` is unchanged business logic (Flabs, pipeline, store, settings).

## Run locally

```bash
npm install --legacy-peer-deps
npm run dev
```

Open http://localhost:5174. The API is on the same address (`/api/health`).

Production build check:

```bash
npm run build
npm start
```

Locally, the Settings screen can still create the encryption key and save a public address. They are written to `.secrets/app.env` (git-ignored).

## Deploy on Vercel

1. Push this folder to a GitHub repository (without `.secrets/`, `node_modules/`, `.next/`; these are in `.gitignore`).
2. In Vercel, choose **Add New → Project** and import the repository. Vercel detects Next.js. Keep the default build command (`next build`).
3. In **Project Settings → Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `MONGODB_URI` | Your MongoDB Atlas connection string (`mongodb+srv://...`) |
   | `MONGODB_DB` | Optional database name (default `healjour_integration_studio`) |
   | `FLABS_SECRET_KEY` | A 32-byte base64 key. Use the same key as your local `.secrets/app.env` if you want to keep secrets that were encrypted locally, or make a new one. |
   | `PUBLIC_BASE_URL` | The deployed address, for example `https://your-app.vercel.app` or your own domain |
   | `FLABS_CLIENT_ID` / `FLABS_CLIENT_SECRET` | Optional: the Flabs lab account to connect automatically on start (no form to fill) |
   | `FLABS_BRANCH_ID` | The Flabs lab ID (labID) for that account |
   | `FLABS_LABEL` | Optional name shown in the app (default "Flabs lab (auto-connected)") |
   | `FLABS_BASE_URL` | Optional, default `https://v2.flabs.in` |
   | `ANTHROPIC_API_KEY` | Optional: turns on AI in Test Builder (Claude reads free-text test lists and matches tests to Flabs by meaning). Without it the builder uses simple rules. |
   | `PORTAL_SETUP_KEY` | Recommended on a public deployment: a secret that must be typed on the first-run screen to create the first Healjour admin, so nobody else can claim it. |

   With these set, the lab account connects on start and its tests sync with Flabs automatically (every 30 min).
   To make every Healjour booking also create a Flabs pre-booking, open Orders & Bookings → Pre-booking →
   Pre-booking setup, tick "Auto pre-booking" and choose the default lead source.

   Make a new key with:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

4. Deploy. Then open `https://<your-domain>/api/health`. It should show `"storage": { "kind": "mongodb", "durable": true }`.
5. In MongoDB Atlas → **Network Access**, allow Vercel to connect (for a start, `0.0.0.0/0`, protected by your database user and password).
6. Open the app, go to **Test Catalog → Flabs CRM accounts**, connect the account, then press **Register webhooks**. Flabs will now call `https://<your-domain>/api/webhooks/flabs/<token>`.

## Notes for Vercel

- MongoDB is required there. Without it, each serverless instance keeps its own memory and data disappears.
- The Settings screen cannot write files on Vercel. It shows a message to set `FLABS_SECRET_KEY` and `PUBLIC_BASE_URL` in Environment Variables instead.
- Your own domain: **Project Settings → Domains**, add for example `app.yourwebsite.com`, and create the DNS record Vercel shows. HTTPS is automatic.

## Sign-in and Lab Portal

- Two addresses: `/admin` is the Healjour admin sign-in and dashboard (first-run **Set up the first admin** appears only here); `/` is the Lab Portal sign-in for partner labs. Each page accepts only its own kind of account.
- Healjour admin: **Labs & Users** adds labs and their users (one-time password shown once), **Lab Cases** sends bookings to a lab and shows every update.
- Lab users sign in at the same address and see only the Lab Portal with their own lab's cases. Roles: lab admin (cases + team), lab staff (status, results, reports), viewer (read and download).
- Users, sessions, cases and reports are stored in MongoDB (collections portalUsers, portalSessions, portalLabs, labCases, labCaseReports).
