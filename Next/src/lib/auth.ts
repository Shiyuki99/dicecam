import {
  onAuthStateChanged,
  signInAnonymously,
  type Auth,
  type User,
} from "firebase/auth";
import { getFirebase } from "./firebase";

let pending: Promise<User> | null = null;

/**
 * Shared anonymous sign-in.
 *
 * Both the chat hook and the presence tracker need a UID. Firebase mints a
 * NEW anonymous user whenever signInAnonymously() really signs in (it only
 * reuses the current one when it is already anonymous), and a second sign-in
 * replaces the first — so two concurrent sign-ins could leave the tracker
 * and the signaling layer pointing at two different UUIDs. One shared
 * promise keeps every feature on the same identity.
 */
export function ensureAnonymousAuth(): Promise<User> {
  if (!pending) {
    pending = signIn().catch((e) => {
      pending = null; // let the next caller retry
      throw e;
    });
  }
  return pending;
}

async function signIn(): Promise<User> {
  const { auth } = getFirebase();
  if (!auth) throw new Error("Firebase not available.");
  // A persisted anonymous session (IndexedDB) is reused as-is.
  const existing = await firstAuthState(auth);
  if (existing) return existing;
  await signInAnonymously(auth);
  const user = await firstAuthState(auth);
  if (!user) throw new Error("Anonymous sign-in failed.");
  return user;
}

/** Resolves with the signed-in user, or null if auth settles signed-out. */
function firstAuthState(auth: Auth): Promise<User | null> {
  return new Promise((resolve) => {
    let settled = false;
    const unsub = onAuthStateChanged(
      auth,
      (u) => {
        if (settled) return;
        settled = true;
        unsub();
        resolve(u);
      },
      () => {
        if (settled) return;
        settled = true;
        unsub();
        resolve(null);
      }
    );
  });
}
