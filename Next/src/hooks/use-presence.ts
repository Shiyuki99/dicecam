"use client";

import { useEffect, useRef, useState } from "react";
import { ensureAnonymousAuth } from "@/lib/auth";
import {
  HEARTBEAT_MS,
  REAP_INTERVAL_MS,
  RECOMPUTE_MS,
  recomputeStats,
  reapStalePresence,
  subscribeLiveStats,
  unregisterPresence,
  upsertPresence,
  type LiveStats,
  type PresenceState,
} from "@/lib/presence";

const EMPTY: LiveStats = { online: 0, inCall: 0, calls: 0 };

/**
 * Live "people online" tracker.
 *
 * Registers the anonymous user in the presence collection, keeps a
 * heartbeat alive, publishes the current chat state (searching / in a
 * call) and exposes the aggregated counters.
 */
export function usePresence(state: PresenceState) {
  const [stats, setStats] = useState<LiveStats>(EMPTY);
  const [tracking, setTracking] = useState(false);
  const uidRef = useRef<string | null>(null);
  const activeRef = useRef(false);
  const stateRef = useRef(state);

  // Keep the latest state in a ref so the mount effect never reads a
  // stale closure value.
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Register + heartbeat + janitor.
  useEffect(() => {
    let cancelled = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let reaper: ReturnType<typeof setInterval> | null = null;
    let recomputer: ReturnType<typeof setInterval> | null = null;
    let unsubscribeStats: (() => void) | null = null;

    const leave = () => {
      const uid = uidRef.current;
      uidRef.current = null;
      if (uid) void unregisterPresence(uid);
    };

    const start = async () => {
      try {
        const user = await ensureAnonymousAuth();
        if (cancelled) return;
        uidRef.current = user.uid;
        // The counters doc is readable by signed-in users only, so the
        // live subscription starts after the anonymous sign-in.
        unsubscribeStats = subscribeLiveStats(setStats, () => {
          setTracking(false);
        });
        const ok = await upsertPresence(user.uid, stateRef.current);
        if (!ok) {
          // Usually the presence rules are not deployed yet.
          console.warn(
            "presence tracker offline — deploy Next/firestore.rules to enable it."
          );
          setTracking(false);
          return;
        }
        setTracking(true);
        activeRef.current = true;
        if (cancelled) return;
        heartbeat = setInterval(() => {
          const uid = uidRef.current;
          if (uid) void upsertPresence(uid, stateRef.current);
        }, HEARTBEAT_MS);
        reaper = setInterval(() => {
          void reapStalePresence();
        }, REAP_INTERVAL_MS);
        recomputer = setInterval(() => {
          void recomputeStats();
        }, RECOMPUTE_MS);
      } catch (e) {
        console.warn("presence tracking unavailable:", (e as Error)?.message);
      }
    };
    void start();

    // pagehide fires on tab close / navigation more reliably than
    // beforeunload (mobile, bfcache).
    const onPageHide = () => leave();
    window.addEventListener("pagehide", onPageHide);

    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", onPageHide);
      if (heartbeat) clearInterval(heartbeat);
      if (reaper) clearInterval(reaper);
      if (recomputer) clearInterval(recomputer);
      if (unsubscribeStats) unsubscribeStats();
      leave();
    };
  }, []);

  // Publish state changes (searching / connected / …) right away.
  useEffect(() => {
    const uid = uidRef.current;
    if (uid && activeRef.current) void upsertPresence(uid, state);
  }, [state]);

  return { ...stats, tracking };
}
