import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
  type DocumentData,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { getFirebase } from "./firebase";

/**
 * Online-people tracker.
 *
 * Every browser that opens the app owns ONE presence doc (doc id = the
 * anonymous Firebase UID) and refreshes it with a heartbeat:
 *
 *   presence/<uid>            { state, lastSeen }
 *   presence_stats/live       { online, inCall, calls, updatedAt, recomputedAt }
 *
 * `presence` is the truth, `presence_stats/live` is the aggregated
 * counter every client renders — one doc read instead of one read per
 * online user, so the tracker stays cheap at scale.
 *
 * The counters are kept in sync incrementally (transactional) and
 * re-derived from scratch every RECOMPUTE_MS, so a client that dies
 * mid-session (crash, killed tab, closed laptop) can never leave the
 * number permanently wrong.
 */

export type PresenceState = "idle" | "searching" | "connected" | "peer-left";

export interface LiveStats {
  /** Unique anonymous users seen in the last STALE_MS. */
  online: number;
  /** Users currently in a call (state = "connected"). */
  inCall: number;
  /** Cumulative successful matches (connections established). */
  calls: number;
}

export const PRESENCE_COLLECTION =
  process.env.NEXT_PUBLIC_FIREBASE_PRESENCE_COLLECTION || "presence";
export const STATS_COLLECTION =
  process.env.NEXT_PUBLIC_FIREBASE_STATS_COLLECTION || "presence_stats";

/** One heartbeat write per user per tick. */
export const HEARTBEAT_MS = 45_000;
/** A presence doc older than this counts as dead (3 missed heartbeats). */
export const STALE_MS = HEARTBEAT_MS * 3;
/** How often a client reaps dead presence docs. */
export const REAP_INTERVAL_MS = 60_000;
/** How often a client re-derives the counters from the presence docs. */
export const RECOMPUTE_MS = 5 * 60_000;

const REAP_LIMIT = 25;
const STATS_DOC_ID = "live";

function getDb(): Firestore | null {
  return getFirebase().db;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function millis(v: unknown): number {
  const ts = v as { toMillis?: () => number } | undefined;
  const ms = typeof ts?.toMillis === "function" ? ts.toMillis() : NaN;
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Create-or-refresh this user's presence doc and keep the counters in
 * step. Doubles as the heartbeat (state unchanged → counters untouched).
 * Returns false when the write was rejected (e.g. the presence rules are
 * not deployed yet).
 */
export async function upsertPresence(
  uid: string,
  state: PresenceState
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  try {
    await runTransaction(db, async (tx) => {
      const presenceRef = doc(db, PRESENCE_COLLECTION, uid);
      const presenceSnap = await tx.get(presenceRef);
      const existed = presenceSnap.exists();
      const prevState = existed
        ? (presenceSnap.data()?.state as PresenceState | undefined)
        : undefined;

      // The counters can only change when the doc is new or the state
      // flipped — skip the extra read otherwise (heartbeat path).
      const countersChange = !existed || prevState !== state;
      const statsRef = doc(db, STATS_COLLECTION, STATS_DOC_ID);
      const statsSnap = countersChange ? await tx.get(statsRef) : null;
      const stats = statsSnap?.data() ?? {};

      tx.set(presenceRef, { state, lastSeen: serverTimestamp() });

      if (!statsSnap) return;
      let online = num(stats.online);
      let inCall = num(stats.inCall);
      let calls = num(stats.calls);
      if (!existed) online += 1;
      if (prevState !== state) {
        if (state === "connected") {
          inCall += 1;
          calls += 1;
        } else if (prevState === "connected") {
          inCall = Math.max(0, inCall - 1);
        }
      }
      tx.set(
        statsRef,
        { online, inCall, calls, updatedAt: serverTimestamp() },
        { merge: true }
      );
    });
    return true;
  } catch (e) {
    console.warn("presence update failed:", (e as Error)?.message);
    return false;
  }
}

/** Remove this user's presence doc (tab closed / page unloaded). */
export async function unregisterPresence(uid: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await runTransaction(db, async (tx) => {
      const presenceRef = doc(db, PRESENCE_COLLECTION, uid);
      const presenceSnap = await tx.get(presenceRef);
      if (!presenceSnap.exists()) return;
      const state = presenceSnap.data()?.state;

      const statsRef = doc(db, STATS_COLLECTION, STATS_DOC_ID);
      const statsSnap = await tx.get(statsRef);
      const stats = statsSnap.data() ?? {};

      tx.delete(presenceRef);
      tx.set(
        statsRef,
        {
          online: Math.max(0, num(stats.online) - 1),
          inCall: Math.max(0, num(stats.inCall) - (state === "connected" ? 1 : 0)),
          calls: num(stats.calls),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    });
  } catch {
    /* best effort — the janitor reaps whatever is left behind */
  }
}

/**
 * Janitor: delete presence docs whose heartbeat stopped (dead tab, crash)
 * and fix the counters they were part of. Anyone may run it.
 */
export async function reapStalePresence(): Promise<void> {
  const db = getDb();
  if (!db) return;
  let stale: QueryDocumentSnapshot<DocumentData>[] = [];
  try {
    const cutoff = Timestamp.fromMillis(Date.now() - STALE_MS);
    stale = (
      await getDocs(
        query(
          collection(db, PRESENCE_COLLECTION),
          where("lastSeen", "<=", cutoff),
          limit(REAP_LIMIT)
        )
      )
    ).docs;
  } catch {
    return;
  }
  for (const staleDoc of stale) {
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(staleDoc.ref);
        if (!snap.exists()) return;
        const state = snap.data()?.state;

        const statsRef = doc(db, STATS_COLLECTION, STATS_DOC_ID);
        const statsSnap = await tx.get(statsRef);
        const stats = statsSnap.data() ?? {};

        tx.delete(staleDoc.ref);
        tx.set(
          statsRef,
          {
            online: Math.max(0, num(stats.online) - 1),
            inCall: Math.max(
              0,
              num(stats.inCall) - (state === "connected" ? 1 : 0)
            ),
            calls: num(stats.calls),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      });
    } catch {
      /* another client reaped it first, or a write failed — next sweep */
    }
  }
}

/**
 * Re-derive online / inCall straight from the presence docs. This is the
 * self-heal: any drift left by a crash or a lost increment is corrected
 * here, so the badge never sticks on a wrong number.
 */
export async function recomputeStats(): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    const statsRef = doc(db, STATS_COLLECTION, STATS_DOC_ID);
    const statsSnap = await getDoc(statsRef);
    const lastRun = millis(statsSnap.data()?.recomputedAt);
    // Another client did this recently — skip (keeps the reads spread out).
    if (Number.isFinite(lastRun) && Date.now() - lastRun < RECOMPUTE_MS) return;

    const snap = await getDocs(collection(db, PRESENCE_COLLECTION));
    const now = Date.now();
    let online = 0;
    let inCall = 0;
    snap.forEach((entry) => {
      const data = entry.data();
      const seen = millis(data?.lastSeen);
      if (!Number.isFinite(seen) || now - seen > STALE_MS) return;
      online += 1;
      if (data?.state === "connected") inCall += 1;
    });

    await runTransaction(db, async (tx) => {
      const cur = await tx.get(statsRef);
      const stats = cur.data() ?? {};
      tx.set(
        statsRef,
        {
          online,
          inCall,
          calls: num(stats.calls),
          updatedAt: serverTimestamp(),
          recomputedAt: serverTimestamp(),
        },
        { merge: true }
      );
    });
  } catch (e) {
    console.warn("presence recompute failed:", (e as Error)?.message);
  }
}

/** Live counters — one doc, so this is a single cheap read per change. */
export function subscribeLiveStats(
  onChange: (stats: LiveStats) => void,
  onError?: (error: unknown) => void
): () => void {
  const db = getDb();
  if (!db) {
    onChange({ online: 0, inCall: 0, calls: 0 });
    return () => {};
  }
  return onSnapshot(
    doc(db, STATS_COLLECTION, STATS_DOC_ID),
    (snap) => {
      const data = snap.data() ?? {};
      onChange({
        online: num(data.online),
        inCall: num(data.inCall),
        calls: num(data.calls),
      });
    },
    (err) => {
      // Rules not deployed yet / no permission — the badge goes offline
      // instead of showing a fake "0 online".
      onError?.(err);
    }
  );
}
