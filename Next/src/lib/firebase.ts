import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getAuth, type Auth } from "firebase/auth";
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
  type AppCheck,
} from "firebase/app-check";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export const CONNECTIONS_COLLECTION =
  process.env.NEXT_PUBLIC_FIREBASE_DB_COLLECTION || "connections";

// App Check (reCAPTCHA v3). Get the site key from Google reCAPTCHA admin
// console, register it under Firebase Console → App Check → Apps, then set
// NEXT_PUBLIC_RECAPTCHA_SITE_KEY. Until you flip Firestore to "Enforced" in
// the App Check console, tokens are minted but not required — safe to ship
// first, enforce after verifying traffic in the metrics dashboard.
const RECAPTCHA_SITE_KEY = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;
const APPCHECK_DEBUG = process.env.NEXT_PUBLIC_FIREBASE_APPCHECK_DEBUG === "true";

// Firebase touches browser-only APIs, so we lazily initialise on the client only.
let _app: FirebaseApp | null = null;
let _db: Firestore | null = null;
let _auth: Auth | null = null;
let _check: AppCheck | null = null;

function hasConfig(): boolean {
  return Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.authDomain &&
      firebaseConfig.projectId &&
      firebaseConfig.appId
  );
}

function ensureAppCheck(app: FirebaseApp) {
  if (_check || typeof window === "undefined") return;
  if (!RECAPTCHA_SITE_KEY) {
    console.warn(
      "NEXT_PUBLIC_RECAPTCHA_SITE_KEY missing; App Check disabled (set it + enforce in console to block bot traffic)."
    );
    return;
  }
  try {
    if (APPCHECK_DEBUG) {
      // Localhost dev only: prints a debug token to console; register it in
      // Firebase Console → App Check → Manage debug tokens.
      (self as unknown as Record<string, unknown>).FIREBASE_APPCHECK_DEBUG_TOKEN =
        true;
    }
    _check = initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(RECAPTCHA_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (e) {
    console.warn("App Check init failed:", (e as Error)?.message);
  }
}

export function getFirebase() {
  if (typeof window === "undefined") {
    return { app: null, db: null, auth: null };
  }
  if (!hasConfig()) {
    console.warn("Firebase env vars missing; signaling unavailable.");
    return { app: null, db: null, auth: null };
  }
  if (!_app) {
    _app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    _db = getFirestore(_app);
    _auth = getAuth(_app);
  }
  ensureAppCheck(_app);
  return { app: _app, db: _db as Firestore, auth: _auth as Auth };
}
