import { initializeApp, cert, getApps, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set. Did you forget to provision Firebase?`);
  }
  return value;
}

// Reuse the existing app across hot reloads / multiple imports instead of
// re-initializing (firebase-admin throws if you call initializeApp twice).
const app: App =
  getApps()[0] ??
  initializeApp({
    credential: cert({
      projectId: requireEnv("FIREBASE_PROJECT_ID"),
      clientEmail: requireEnv("FIREBASE_CLIENT_EMAIL"),
      // Service-account keys are stored with literal "\n" sequences in most
      // env-var systems (they can't hold real newlines) — undo that here.
      privateKey: requireEnv("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n"),
    }),
  });

export const firebaseAuth: Auth = getAuth(app);
