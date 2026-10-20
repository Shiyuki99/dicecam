"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  collection,
  addDoc,
  getDocs,
  onSnapshot,
  deleteDoc,
  query,
  where,
  limit,
  runTransaction,
  serverTimestamp,
  type DocumentReference,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { type User } from "firebase/auth";
import { getFirebase, CONNECTIONS_COLLECTION } from "@/lib/firebase";
import { ensureAnonymousAuth as ensureSharedAuth } from "@/lib/auth";
import { checkFaceOnce } from "./use-face-gate";

export type ChatStatus = "idle" | "searching" | "connected" | "peer-left";
export type ChatRole = "caller" | "callee" | null;

export type PermissionKind =
  | "denied"
  | "no-device"
  | "busy"
  | "unsupported"
  | "insecure";

export interface PermissionErrorInfo {
  kind: PermissionKind;
  title: string;
  message: string;
  /** Browser will allow getUserMedia to prompt again (denied, non-dismissed). */
  canReprompt: boolean;
}

export interface ChatMessage {
  id: string;
  from: "me" | "stranger";
  text: string;
  ts: number;
}

export interface MediaDeviceOption {
  deviceId: string;
  label: string;
}

interface RoomInfo {
  Ref: DocumentReference | null;
  Id: string | null;
}

interface ActiveRoom {
  roomId: string | null;
  ownerUid: string | null;
  joinedUid: string | null;
}

const ICE_SERVERS = {
  iceServers: [
    {
      urls: [
        "stun:stun1.l.google.com:19302",
        "stun:stun2.l.google.com:19302",
      ],
    },
  ],
  iceCandidatePoolSize: 10,
} as RTCConfiguration;

/** Fresh-session retry policy for failed / timed-out connections. */
const SEARCH_TIMEOUT_MS = 25_000;
const MAX_AUTO_RETRIES = 2;
const RETRY_DELAY_MS = 1_200;
/** Cap chat history so a long session can't grow memory unboundedly. */
const MAX_MESSAGES = 200;
/** Cap signaling-adjacent payloads; oversize frames are dropped, not rendered. */
const MAX_MESSAGE_LEN = 2_000;
/** Client-side abuse gates (server enforcement = App Check + rules). */
const START_COOLDOWN_MS = 3_000; // min gap between user-initiated starts
const MAX_STARTS_PER_MIN = 8; // room-create cap per rolling 60s window
const START_WINDOW_MS = 60_000;
const MAX_SEND_PER_WINDOW = 8; // chat messages per rolling 10s window
const SEND_WINDOW_MS = 10_000;
const NOTICE_MS = 2_500; // transient rate-limit toast lifetime
/** Janitor: reap open rooms idle this long; capped docs per sweep. */
const STALE_OPEN_ROOM_MS = 10 * 60 * 1000;
/** Janitor: reap claimed (matched) rooms idle this long. */
const STALE_CLAIMED_ROOM_MS = 60 * 60 * 1000;
const SWEEP_LIMIT = 10;
/** Delayed ICE re-sweep catches late candidates from a dying remote peer. */
const RESWEEP_DELAY_MS = 3_000;

let msgSeq = 0;
function makeId() {
  msgSeq += 1;
  return `${Date.now()}-${msgSeq}`;
}

function classifyCameraError(e: unknown): PermissionErrorInfo {
  const err = e as DOMException & { code?: number; message?: string };
  const name = err?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return {
        kind: "denied",
        title: "Camera / mic access blocked",
        message:
          "DiceCam needs camera and microphone access. Grant permission in your browser, then try again.",
        canReprompt: true,
      };
    case "NotFoundError":
    case "OverconstrainedError":
      return {
        kind: "no-device",
        title: "No camera or microphone found",
        message:
          "No usable camera/microphone was found. Plug one in (or pick another device), then try again.",
        canReprompt: true,
      };
    case "NotReadableError":
    case "AbortError":
      return {
        kind: "busy",
        title: "Camera is busy",
        message:
          "The camera couldn't be started — usually another tab or app is holding it, or the OS is blocking this browser. Close the other app/tab, check OS camera privacy settings, then try again.",
        canReprompt: true,
      };
    default:
      return {
        kind: "unsupported",
        title: "Camera unavailable",
        message:
          "Could not access camera/microphone on this device or browser. Try a modern browser over HTTPS.",
        canReprompt: false,
      };
  }
}

/** Best-effort label of which device the browser reports as denied. */
async function queryDevicePermissionStates(): Promise<{
  camera: string;
  mic: string;
}> {
  const fallback = { camera: "unknown", mic: "unknown" };
  try {
    const nav = navigator as Navigator & {
      permissions?: {
        query(o: { name: string }): Promise<{ state: string }>;
      };
    };
    if (!nav.permissions?.query) return fallback;
    const [cam, mic] = await Promise.all([
      nav.permissions.query({ name: "camera" as PermissionName }).catch(() => null),
      nav.permissions.query({ name: "microphone" as PermissionName }).catch(() => null),
    ]);
    return {
      camera: cam?.state ?? "unknown",
      mic: mic?.state ?? "unknown",
    };
  } catch {
    return fallback;
  }
}

function isRetryableStartError(e: unknown): boolean {
  const err = e as { code?: string; message?: string; name?: string };
  const hay = `${err?.code ?? ""} ${err?.message ?? ""} ${err?.name ?? ""}`.toLowerCase();
  return (
    hay.includes("unavailable") ||
    hay.includes("deadline-exceeded") ||
    hay.includes("internal") ||
    hay.includes("failed") ||
    hay.includes("timeout") ||
    hay.includes("network") ||
    hay.includes("not authenticated") ||
    hay.includes("invalid state") ||
    hay.includes("invalidaccess")
  );
}

function validSdp(value: unknown): value is RTCSessionDescriptionInit {
  if (!value || typeof value !== "object") return false;
  const v = value as { type?: unknown; sdp?: unknown };
  return (
    typeof v.type === "string" &&
    typeof v.sdp === "string" &&
    v.sdp.length > 0 &&
    v.sdp.length <= 64 * 1024
  );
}

/**
 * Random peer-to-peer video chat over WebRTC, using Firestore as a minimal
 * signaling/matchmaking layer. Mirrors the original app.js flow but:
 *  - disconnects the peer connection FIRST, then cleans Firestore in the
 *    background (non-blocking);
 *  - tracks and tears down onSnapshot listeners (no leaks across "next");
 *  - wires up a real RTCDataChannel for text messaging.
 */
export function useRandomChat() {
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [channelOpen, setChannelOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canRetryError, setCanRetryError] = useState(false);
  const [permissionError, setPermissionError] =
    useState<PermissionErrorInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [faceEnablePrompt, setFaceEnablePrompt] = useState(false);
  const [role, setRole] = useState<ChatRole>(null);
  // Device toggles: track.enabled flips, no renegotiation needed.
  // Camera off = audio + text continue; both off = text-only mode.
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const cameraOnRef = useRef(true);
  const micOnRef = useRef(true);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  // Peer-bound video ORIGINAL (enabled only when on + verified). Preview
  // + detector run on a live clone inside localStream.
  const peerVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const userRef = useRef<User | null>(null);
  const authReadyRef = useRef(false);

  const roomInfoRef = useRef<RoomInfo>({ Ref: null, Id: null });
  const activeRoomRef = useRef<ActiveRoom>({
    roomId: null,
    ownerUid: null,
    joinedUid: null,
  });

  const unsubsRef = useRef<Array<() => void>>([]);

  // Guards against the peer's own close/cancel events firing while we hang up.
  const intentionalCloseRef = useRef(false);
  const peerLeftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const guardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectedRef = useRef(false);
  const mountedRef = useRef(true);
  const sessionRef = useRef(0);
  const retryCountRef = useRef(0);

  // Forward refs so peer-event handlers (defined below) can trigger a fresh
  // session retry. Synced via effects — never written during render.
  const startRef = useRef<
    (opts?: { resetRetries?: boolean; force?: boolean }) => Promise<void>
  >(async () => {});
  const scheduleFreshRetryRef = useRef<
    ((session: number, reason: string) => void) | null
  >(null);

  // Rate-limit bookkeeping (timestamps of recent user actions).
  const lastStartAtRef = useRef(0);
  const startTimesRef = useRef<number[]>([]);
  const sendTimesRef = useRef<number[]>([]);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resweepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const failSession = useCallback(() => {
    scheduleFreshRetryRef.current?.(sessionRef.current, "failed");
  }, []);

  const dismissError = useCallback(() => {
    setError(null);
    setCanRetryError(false);
  }, []);

  const dismissPermissionError = useCallback(
    () => setPermissionError(null),
    []
  );

  const clearPeerLeftTimer = useCallback(() => {
    if (peerLeftTimerRef.current) {
      clearTimeout(peerLeftTimerRef.current);
      peerLeftTimerRef.current = null;
    }
  }, []);

  const clearSearchTimer = useCallback(() => {
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
  }, []);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const clearGuardTimer = useCallback(() => {
    if (guardTimerRef.current) {
      clearTimeout(guardTimerRef.current);
      guardTimerRef.current = null;
    }
  }, []);

  const clearNoticeTimer = useCallback(() => {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
  }, []);

  const clearResweepTimer = useCallback(() => {
    if (resweepTimerRef.current) {
      clearTimeout(resweepTimerRef.current);
      resweepTimerRef.current = null;
    }
  }, []);

  const clearAllTimers = useCallback(() => {
    clearPeerLeftTimer();
    clearSearchTimer();
    clearRetryTimer();
    clearGuardTimer();
    clearNoticeTimer();
    clearResweepTimer();
  }, [clearPeerLeftTimer, clearSearchTimer, clearRetryTimer, clearGuardTimer, clearNoticeTimer, clearResweepTimer]);

  /** Transient toast for rate-limit hits (auto-dismisses, no dialog). */
  const showNotice = useCallback(
    (text: string) => {
      if (!mountedRef.current) return;
      setNotice(text);
      clearNoticeTimer();
      noticeTimerRef.current = setTimeout(() => {
        noticeTimerRef.current = null;
        if (mountedRef.current) setNotice(null);
      }, NOTICE_MS);
    },
    [clearNoticeTimer]
  );

  /** Public toast for UI-driven events (face gate, etc.). */
  const notify = useCallback(
    (text: string) => {
      showNotice(text);
    },
    [showNotice]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Best-effort room delete on tab close. The async delete usually loses
  // the race with page unload — the sweep-on-start janitor covers the rest.
  // pagehide fires more reliably than beforeunload (mobile, bfcache).
  useEffect(() => {
    const onUnload = () => {
      const ref = roomInfoRef.current.Ref;
      if (ref) deleteDoc(ref).catch(() => {});
      // Inline (not stopLocalStream — declared below): unload must release
      // preview clone AND peer original or the camera light stays on.
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            /* noop */
          }
        });
      }
      if (peerVideoTrackRef.current) {
        try {
          peerVideoTrackRef.current.stop();
        } catch {
          /* noop */
        }
      }
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("pagehide", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("pagehide", onUnload);
    };
  }, []);

  /* ------------------------------ Messaging ------------------------------- */
  const pushMessage = useCallback(
    (from: "me" | "stranger", text: string) => {
      const safe = text.slice(0, MAX_MESSAGE_LEN);
      setMessages((prev) => {
        const next = [
          ...prev,
          { id: makeId(), from, text: safe, ts: Date.now() },
        ];
        return next.length > MAX_MESSAGES
          ? next.slice(next.length - MAX_MESSAGES)
          : next;
      });
    },
    []
  );

  /* ------------------------- Firestore cleanup ---------------------------- */
  const deleteCollectionDocs = useCallback(async (name: string) => {
    const { db } = getFirebase();
    if (!db) return;
    const snapshot = await getDocs(collection(db, name));
    await Promise.all(snapshot.docs.map((entry) => deleteDoc(entry.ref)));
  }, []);

  const cleanupRemoteRoomData = useCallback(
    async (captured: { info: RoomInfo; room: ActiveRoom }) => {
      const { db } = getFirebase();
      const user = userRef.current;
      if (!db || !user || !captured.info.Ref) return;

      const canCleanup =
        user.uid === captured.room.ownerUid ||
        user.uid === captured.room.joinedUid;
      if (!canCleanup) return;

      const roomId = captured.room.roomId || captured.info.Id;
      if (roomId) {
        try {
          await deleteCollectionDocs(roomId + "caller");
          await deleteCollectionDocs(roomId + "callee");
        } catch (e) {
          console.warn("ICE collection cleanup failed:", (e as Error)?.message);
        }
      }
      try {
        await deleteDoc(captured.info.Ref);
      } catch (e) {
        console.warn("room doc cleanup failed:", (e as Error)?.message);
      }
    },
    [deleteCollectionDocs]
  );

  /**
   * Janitor: reap abandoned rooms so tab-close / crash orphans die on the
   * next visit instead of piling up. Two passes — open rooms idle 10min
   * (caller vanished before match) AND claimed rooms idle 60min (both
   * sides gone). Capped per sweep; warn-only failures. Rules allow anyone
   * to delete rooms idle past those thresholds.
   */
  const sweepStaleRooms = useCallback(async () => {
    const { db } = getFirebase();
    if (!db || !userRef.current) return;
    const now = Date.now();
    const isStale = (
      d: QueryDocumentSnapshot<DocumentData>,
      maxAgeMs: number
    ) => {
      const ts = d.data()?.createdAt as { toMillis?: () => number } | undefined;
      const ms = typeof ts?.toMillis === "function" ? ts.toMillis() : NaN;
      return Number.isFinite(ms) && now - (ms as number) > maxAgeMs;
    };
    const reap = (docs: QueryDocumentSnapshot<DocumentData>[]) =>
      Promise.all(
        docs.map(async (d) => {
          const data = d.data();
          // Room first: once it's gone, anyone may reap its ICE (orphan rule).
          try {
            await deleteDoc(d.ref);
          } catch {
            return;
          }
          const rid = typeof data?.id === "string" ? (data.id as string) : null;
          if (!rid) return;
          try {
            await deleteCollectionDocs(rid + "caller");
            await deleteCollectionDocs(rid + "callee");
          } catch {
            /* late ICE dies on a later sweep / resweep */
          }
        })
      );
    try {
      const open = (
        await getDocs(
          query(
            collection(db, CONNECTIONS_COLLECTION),
            where("available", "==", true),
            limit(SWEEP_LIMIT)
          )
        )
      ).docs;
      await reap(open.filter((d) => isStale(d, STALE_OPEN_ROOM_MS)));
      // Single-field equality queries need no composite index — the age
      // filter runs client-side.
      const claimed = (
        await getDocs(
          query(
            collection(db, CONNECTIONS_COLLECTION),
            where("available", "==", false),
            limit(SWEEP_LIMIT)
          )
        )
      ).docs;
      await reap(claimed.filter((d) => isStale(d, STALE_CLAIMED_ROOM_MS)));
    } catch {
      /* janitor best-effort */
    }
  }, [deleteCollectionDocs]);

  /* --------------------------- Peer teardown ------------------------------ */
  /** Synchronously tear down peer + listeners + timers. No Firestore I/O. */
  const teardownPeerSync = useCallback(() => {
    clearPeerLeftTimer();
    clearSearchTimer();
    connectedRef.current = false;
    setChannelOpen(false);
    setRemoteStream(null);

    const pc = peerRef.current;
    peerRef.current = null;
    if (pc) {
      try {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.ondatachannel = null;
        pc.onconnectionstatechange = null;
        pc.oniceconnectionstatechange = null;
        pc.close();
      } catch {
        /* noop */
      }
    }
    if (channelRef.current) {
      try {
        channelRef.current.onopen = null;
        channelRef.current.onclose = null;
        channelRef.current.onmessage = null;
        channelRef.current.onerror = null;
        channelRef.current.close();
      } catch {
        /* noop */
      }
      channelRef.current = null;
    }

    unsubsRef.current.forEach((u) => {
      try {
        u();
      } catch {
        /* noop */
      }
    });
    unsubsRef.current = [];
  }, [clearPeerLeftTimer, clearSearchTimer]);

  /* --------------------------- Peer-left handling ------------------------- */
  const handlePeerLeft = useCallback(() => {
    clearPeerLeftTimer();
    if (intentionalCloseRef.current) return;
    teardownPeerSync();

    const captured = {
      info: { ...roomInfoRef.current },
      room: { ...activeRoomRef.current },
    };
    roomInfoRef.current = { Ref: null, Id: null };
    activeRoomRef.current = { roomId: null, ownerUid: null, joinedUid: null };

    cleanupRemoteRoomData(captured).catch((e) =>
      console.warn("background cleanup failed:", (e as Error)?.message)
    );

    setStatus("peer-left");
  }, [clearPeerLeftTimer, teardownPeerSync, cleanupRemoteRoomData]);

  /* ------------------------------ Data channel ---------------------------- */
  const wireDataChannel = useCallback(
    (channel: RTCDataChannel) => {
      channelRef.current = channel;
      channel.onopen = () => {
        if (mountedRef.current) setChannelOpen(true);
      };
      channel.onclose = () => {
        if (mountedRef.current) setChannelOpen(false);
        if (!intentionalCloseRef.current) handlePeerLeft();
      };
      channel.onerror = () => {
        if (mountedRef.current) setChannelOpen(false);
      };
      channel.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as { text?: unknown };
          if (
            payload &&
            typeof payload.text === "string" &&
            payload.text.length > 0 &&
            payload.text.length <= MAX_MESSAGE_LEN
          ) {
            pushMessage("stranger", payload.text);
          }
          /* oversize / malformed frames dropped silently */
        } catch {
          /* ignore malformed frames */
        }
      };
    },
    [handlePeerLeft, pushMessage]
  );

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim().slice(0, MAX_MESSAGE_LEN);
      if (!trimmed) return false;
      // Sliding-window spam gate: max N messages per window.
      const now = Date.now();
      sendTimesRef.current = sendTimesRef.current.filter(
        (t) => now - t < SEND_WINDOW_MS
      );
      if (sendTimesRef.current.length >= MAX_SEND_PER_WINDOW) {
        showNotice("Slow down — message not sent.");
        return false;
      }
      const channel = channelRef.current;
      if (!channel || channel.readyState !== "open") return false;
      try {
        channel.send(JSON.stringify({ text: trimmed, ts: now }));
        sendTimesRef.current.push(now);
        pushMessage("me", trimmed);
        return true;
      } catch {
        return false;
      }
    },
    [pushMessage, showNotice]
  );

  /* ----------------------------- Firebase auth ---------------------------- */
  // Shared with the presence tracker so both use the same anonymous UID.
  const ensureAnonymousAuth = useCallback(async () => {
    if (authReadyRef.current && userRef.current) return userRef.current;
    const user = await ensureSharedAuth();
    userRef.current = user;
    authReadyRef.current = true;
    return user;
  }, []);

  /* ------------------------------- Camera --------------------------------- */
  // Track model: the peer-bound video ORIGINAL is enabled only while the
  // camera is on AND verified — disabled means black frames flow (clean
  // "camera off", never a frozen frame, no sender surgery, no races).
  // Preview + detector run on a live CLONE in localStream, covered by the
  // "Camera off" overlay whenever cameraOn is false.
  const applyDeviceToggles = useCallback((stream: MediaStream | null) => {
    const cam = cameraOnRef.current;
    const mic = micOnRef.current;
    const peerVideo = peerVideoTrackRef.current;
    if (peerVideo && peerVideo.readyState === "live") peerVideo.enabled = cam;
    stream?.getAudioTracks().forEach((t) => {
      t.enabled = mic;
    });
  }, []);

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  const faceCheckSeqRef = useRef(0);

  const setCameraEnabled = useCallback(
    async (on: boolean) => {
      if (!on) {
        faceCheckSeqRef.current += 1; // cancel any in-flight verify
        cameraOnRef.current = false;
        setCameraOn(false);
        // Peer original goes dark = clean black "camera off" (no freeze,
        // no sender surgery). Preview clone keeps running underneath.
        applyDeviceToggles(localStreamRef.current);
        return;
      }
      const stream = localStreamRef.current;
      const peerAlive =
        !!peerVideoTrackRef.current &&
        peerVideoTrackRef.current.readyState === "live";
      const cloneLive =
        !!stream &&
        stream.getVideoTracks().some((t) => t.readyState === "live");
      if (!stream || !cloneLive || !peerAlive) {
        // No live preview (pre-grant / torn down): state only, acquire
        // verifies before anything is published.
        cameraOnRef.current = true;
        setCameraOn(true);
        return;
      }
      // Verify on the always-live preview clone while the peer original
      // stays dark. Hit → original lights up; miss → it never did.
      const seq = faceCheckSeqRef.current + 1;
      faceCheckSeqRef.current = seq;
      let face: boolean | null = null;
      try {
        face = await checkFaceOnce(stream);
      } catch {
        face = null;
      }
      console.info("[face] enable-check:", face);
      if (!mountedRef.current || faceCheckSeqRef.current !== seq) return;
      if (face === null) {
        // Detector broken (not "no face") — opening anyway, but loudly,
        // so a silently dead gate can never masquerade as a pass again.
        console.warn("[face] detector unavailable — opening unverified");
        showNotice("Face check unavailable — camera opened unverified.");
      } else if (face === false) {
        if (mountedRef.current) setFaceEnablePrompt(true);
        return;
      }
      cameraOnRef.current = true;
      setCameraOn(true);
      setFaceEnablePrompt(false);
      applyDeviceToggles(localStreamRef.current);
    },
    [applyDeviceToggles, showNotice]
  );

  const setMicEnabled = useCallback(
    (on: boolean) => {
      micOnRef.current = on;
      setMicOn(on);
      applyDeviceToggles(localStreamRef.current);
    },
    [applyDeviceToggles]
  );

  const stopLocalStream = useCallback(() => {
    const stopAll = (tracks: MediaStreamTrack[]) => {
      tracks.forEach((t) => {
        try {
          t.stop();
        } catch {
          /* noop */
        }
      });
    };
    if (localStreamRef.current) {
      stopAll(localStreamRef.current.getTracks());
      localStreamRef.current = null;
    }
    // The peer original is a separate object from the preview clone —
    // stopping only the preview would leave the camera light on.
    if (peerVideoTrackRef.current) {
      stopAll([peerVideoTrackRef.current]);
      peerVideoTrackRef.current = null;
    }
    if (mountedRef.current) setLocalStream(null);
  }, []);

  /* ------------------------- Device pick (re-grant) ------------------------ */
  const [videoDevices, setVideoDevices] = useState<MediaDeviceOption[]>([]);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceOption[]>([]);
  const [activeVideoDeviceId, setActiveVideoDeviceId] = useState<string | null>(
    null
  );
  const [activeAudioDeviceId, setActiveAudioDeviceId] = useState<string | null>(
    null
  );
  // Preferred devices survive across retries; picked in the permission
  // dialog when the browser grabbed the wrong camera/mic.
  const preferredVideoDeviceIdRef = useRef<string | null>(null);
  const preferredAudioDeviceIdRef = useRef<string | null>(null);

  const refreshDevices = useCallback(async () => {
    try {
      if (!navigator?.mediaDevices?.enumerateDevices) return;
      const all = await navigator.mediaDevices.enumerateDevices();
      const map = (kind: "videoinput" | "audioinput", fb: string) =>
        all
          .filter((d) => d.kind === kind)
          .map((d, i) => ({
            deviceId: d.deviceId,
            label: d.label || `${fb} ${i + 1}`,
          }));
      if (!mountedRef.current) return;
      setVideoDevices(map("videoinput", "Camera"));
      setAudioDevices(map("audioinput", "Microphone"));
    } catch {
      /* enumeration unavailable — pickers stay hidden */
    }
  }, []);

  /**
   * Switch camera/mic, live if a stream is active (sender.replaceTrack, no
   * renegotiation) or stored as preference for the next acquire when idle
   * (e.g. picked from the busy dialog before retrying). Video swaps the
   * peer-bound original; the preview keeps its own live clone.
   */
  const switchDevice = useCallback(
    async (kind: "video" | "audio", deviceId: string): Promise<boolean> => {
      if (kind === "video") preferredVideoDeviceIdRef.current = deviceId;
      else preferredAudioDeviceIdRef.current = deviceId;

      const cur = localStreamRef.current;
      if (!cur) return true; // preference stored; next acquire uses it
      try {
        const constraints: MediaStreamConstraints =
          kind === "video"
            ? { audio: false, video: { deviceId: { exact: deviceId } } }
            : { audio: { deviceId: { exact: deviceId } }, video: false };
        const ns = await navigator.mediaDevices.getUserMedia(constraints);
        const fresh =
          kind === "video" ? ns.getVideoTracks()[0] : ns.getAudioTracks()[0];
        if (!fresh) {
          ns.getTracks().forEach((t) => {
            try {
              t.stop();
            } catch {
              /* noop */
            }
          });
          return false;
        }
        if (kind === "video") {
          const oldPeer = peerVideoTrackRef.current;
          // New original starts dark unless the camera is on — switching
          // must never leak real frames by itself.
          fresh.enabled = cameraOnRef.current;
          peerVideoTrackRef.current = fresh;
          const pc = peerRef.current;
          if (pc && oldPeer) {
            for (const sender of pc.getSenders()) {
              if (sender.track === oldPeer) {
                try {
                  await sender.replaceTrack(fresh);
                } catch {
                  /* keep old track on failure */
                }
              }
            }
          }
          if (oldPeer && oldPeer !== fresh) {
            try {
              oldPeer.stop();
            } catch {
              /* noop */
            }
          }
          const oldClones = cur.getVideoTracks();
          const clone = fresh.clone();
          clone.enabled = true;
          oldClones.forEach((t) => {
            try {
              t.stop();
            } catch {
              /* noop */
            }
            try {
              cur.removeTrack(t);
            } catch {
              /* noop */
            }
          });
          cur.addTrack(clone);
        } else {
          const olds = cur.getAudioTracks();
          const pc = peerRef.current;
          if (pc) {
            for (const sender of pc.getSenders()) {
              if (sender.track && olds.includes(sender.track)) {
                try {
                  await sender.replaceTrack(fresh);
                } catch {
                  /* keep old track on failure */
                }
              }
            }
          }
          olds.forEach((t) => {
            try {
              t.stop();
            } catch {
              /* noop */
            }
            try {
              cur.removeTrack(t);
            } catch {
              /* noop */
            }
          });
          cur.addTrack(fresh);
        }
        applyDeviceToggles(cur);
        if (mountedRef.current) {
          setLocalStream(new MediaStream(cur.getTracks()));
          if (kind === "video") setActiveVideoDeviceId(deviceId);
          else setActiveAudioDeviceId(deviceId);
        }
        void refreshDevices();
        return true;
      } catch {
        return false;
      }
    },
    [applyDeviceToggles, refreshDevices]
  );

  // Keep the device pickers live as hardware is plugged/unplugged.
  useEffect(() => {
    const md = navigator?.mediaDevices;
    if (!md?.addEventListener) return;
    const onChange = () => {
      void refreshDevices();
    };
    md.addEventListener("devicechange", onChange);
    return () => md.removeEventListener("devicechange", onChange);
  }, [refreshDevices]);

  const ensureCamera = useCallback(async () => {
    // Never trust a cached stream blindly. Drop it when tracks all ended
    // (device slept, unplugged, revoked) OR when video tracks are all
    // muted (OS privacy kill looks "live" but feeds black forever).
    // Re-requesting surfaces the true current error instead of reusing
    // a dead feed.
    const cached = localStreamRef.current;
    if (cached) {
      const tracks = cached.getTracks();
      const anyLive = tracks.some((t) => t.readyState === "live");
      const videos = cached.getVideoTracks();
      const videoDead = videos.length > 0 && videos.every((t) => t.muted);
      if (!anyLive || videoDead) {
        stopLocalStream();
      } else {
        applyDeviceToggles(cached);
        return cached;
      }
    }
    if (typeof window === "undefined" || !navigator?.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error("unsupported"), {
        __permKind: "unsupported" as PermissionKind,
      });
    }
    if (!window.isSecureContext) {
      throw Object.assign(new Error("insecure-context"), {
        __permKind: "insecure" as PermissionKind,
      });
    }
    try {
      const preferredVideo = preferredVideoDeviceIdRef.current;
      const preferredAudio = preferredAudioDeviceIdRef.current;
      const raw = await navigator.mediaDevices.getUserMedia({
        audio: preferredAudio ? { deviceId: { exact: preferredAudio } } : true,
        video: preferredVideo ? { deviceId: { exact: preferredVideo } } : true,
      });
      const originalVideo = raw.getVideoTracks()[0] ?? null;
      const audioTracks = raw.getAudioTracks();
      // Remember what the browser actually opened (labels/ids for pickers).
      const vId = originalVideo?.getSettings().deviceId;
      const aId = audioTracks[0]?.getSettings().deviceId;
      // Peer-bound original starts DARK (black, never real pixels) until a
      // face check explicitly lights it. Preview/detector run on a live
      // clone underneath the "Camera off" overlay.
      if (originalVideo) originalVideo.enabled = false;
      peerVideoTrackRef.current = originalVideo;
      const previewVideo = originalVideo ? originalVideo.clone() : null;
      if (previewVideo) previewVideo.enabled = true;
      const preview = new MediaStream([
        ...(previewVideo ? [previewVideo] : []),
        ...audioTracks,
      ]);
      // Face-first: never publish video until a face is visible. Fail-open
      // when the detector can't load so the call still works.
      if (cameraOnRef.current && previewVideo) {
        let face: boolean | null = null;
        try {
          face = await checkFaceOnce(preview);
        } catch {
          face = null;
        }
        console.info("[face] acquire-check:", face);
        if (face === null) {
          console.warn("[face] detector unavailable — opening unverified");
          if (mountedRef.current) {
            showNotice("Face check unavailable — camera opened unverified.");
          }
        } else if (face === false) {
          cameraOnRef.current = false;
          if (mountedRef.current) {
            setCameraOn(false);
            setFaceEnablePrompt(true);
          }
        }
      }
      applyDeviceToggles(preview);
      localStreamRef.current = preview;
      if (mountedRef.current) {
        setLocalStream(preview);
        if (typeof vId === "string") setActiveVideoDeviceId(vId);
        if (typeof aId === "string") setActiveAudioDeviceId(aId);
      }
      void refreshDevices();
      return preview;
    } catch (e) {
      peerVideoTrackRef.current = null;
      throw e;
    }
  }, [applyDeviceToggles, stopLocalStream, showNotice, refreshDevices]);

  /* ----------------------- Firestore signaling ---------------------------- */
  const trackActiveRoom = useCallback(
    (
      info: RoomInfo,
      roomId: string | null,
      ownerUid: string | null,
      joinedUid: string | null
    ) => {
      roomInfoRef.current = { Ref: info.Ref, Id: info.Id };
      activeRoomRef.current = { roomId, ownerUid, joinedUid };
    },
    []
  );

  const sendCandidateToRemotePeer = useCallback(
    (
      roomId: string,
      peerConnection: RTCPeerConnection,
      role: "caller" | "callee",
      roomOwnerUid: string | null
    ) => {
      const { db } = getFirebase();
      if (!db || !userRef.current) return;
      const ownerUid = userRef.current.uid;
      // Single onicecandidate assignment per peer (nulled on teardown).
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          const json = event.candidate.toJSON();
          addDoc(collection(db, roomId + role), {
            ...json,
            ownerUid,
            usernameFragment: json.usernameFragment || null,
            roomOwnerUid: roomOwnerUid || null,
            roomId,
            createdAt: serverTimestamp(),
          }).catch((err) =>
            console.warn("ICE send failed:", (err as Error)?.message)
          );
        }
      };
    },
    []
  );

  const listenToRemoteCandidate = useCallback(
    (
      roomId: string,
      peerConnection: RTCPeerConnection,
      role: "caller" | "callee"
    ) => {
      const { db } = getFirebase();
      if (!db) return;
      const remoteRole = role === "caller" ? "callee" : "caller";
      const unsub = onSnapshot(
        collection(db, roomId + remoteRole),
        (snapshot) => {
          snapshot.docChanges().forEach((change) => {
            if (change.type === "added") {
              const candidate = new RTCIceCandidate(
                change.doc.data() as RTCIceCandidateInit
              );
              peerConnection
                .addIceCandidate(candidate)
                .catch((err) =>
                  console.warn(
                    "addIceCandidate failed:",
                    (err as Error)?.message
                  )
                );
            }
          });
        },
        (err) =>
          console.warn("remote ICE listen failed:", (err as Error)?.message)
      );
      unsubsRef.current.push(unsub);
    },
    []
  );

  const waitForAnswer = useCallback(
    (info: RoomInfo, peerConnection: RTCPeerConnection) => {
      const { db } = getFirebase();
      if (!db || !info.Ref) return;
      const unsub = onSnapshot(
        info.Ref,
        (snapshot) => {
          const data = snapshot.data();
          if (
            data &&
            !peerConnection.currentRemoteDescription &&
            data.answer
          ) {
            if (!validSdp(data.answer)) {
              console.warn("ignoring malformed answer");
              return;
            }
            const answer = new RTCSessionDescription(
              data.answer as RTCSessionDescriptionInit
            );
            peerConnection
              .setRemoteDescription(answer)
              .catch((err) =>
                console.warn(
                  "setRemoteDescription failed:",
                  (err as Error)?.message
                )
              );
          }
        },
        (err) => console.warn("answer listen failed:", (err as Error)?.message)
      );
      unsubsRef.current.push(unsub);
    },
    []
  );

  const sendOffer = useCallback(
    async (info: RoomInfo, peerConnection: RTCPeerConnection) => {
      const { db } = getFirebase();
      const user = userRef.current;
      if (!db || !user) throw new Error("Not authenticated");

      // Caller owns the data channel — must be created before the offer so it
      // is negotiated into the SDP.
      const channel = peerConnection.createDataChannel("comm");
      wireDataChannel(channel);

      setRole("caller");
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const generateId = Math.random().toString(36).slice(2, 8);
      sendCandidateToRemotePeer(generateId, peerConnection, "caller", user.uid);

      const roomWithOffer = {
        offer: { type: offer.type, sdp: offer.sdp },
        id: generateId,
        available: true,
        joinedUid: null,
        ownerUid: user.uid,
        createdAt: serverTimestamp(),
      };
      info.Ref = await addDoc(
        collection(db, CONNECTIONS_COLLECTION),
        roomWithOffer
      );
      info.Id = info.Ref.id;
      trackActiveRoom(info, generateId, user.uid, null);

      waitForAnswer(info, peerConnection);
      listenToRemoteCandidate(generateId, peerConnection, "caller");
    },
    [
      wireDataChannel,
      sendCandidateToRemotePeer,
      trackActiveRoom,
      waitForAnswer,
      listenToRemoteCandidate,
    ]
  );

  /** Atomically claim an available room; throws if already taken. */
  const claimRoom = useCallback(
    async (
      roomRef: DocumentReference<DocumentData>,
      answer: RTCSessionDescriptionInit,
      uid: string
    ): Promise<{ generateId: string; ownerUid: string | null }> => {
      const { db } = getFirebase();
      if (!db) throw new Error("Not authenticated");
      return runTransaction(db, async (tx) => {
        const snap = await tx.get(roomRef);
        if (!snap.exists()) throw new Error("room-gone");
        const data = snap.data();
        if (data?.available !== true || data?.joinedUid != null) {
          throw new Error("room-taken");
        }
        if (!validSdp(data.offer)) throw new Error("room-malformed");
        tx.update(roomRef, {
          answer: { type: answer.type, sdp: answer.sdp },
          available: false,
          joinedUid: uid,
          ownerUid: data.ownerUid ?? null,
        });
        return {
          generateId: data.id as string,
          ownerUid: (data.ownerUid as string) ?? null,
        };
      });
    },
    []
  );

  const joinCall = useCallback(
    async (info: RoomInfo, peerConnection: RTCPeerConnection) => {
      const { db } = getFirebase();
      const user = userRef.current;
      if (!db || !user) throw new Error("Not authenticated");

      // Only fetch rooms actually available — never the whole collection.
      let candidates: QueryDocumentSnapshot<DocumentData>[] = [];
      try {
        const q = query(
          collection(db, CONNECTIONS_COLLECTION),
          where("available", "==", true),
          limit(5)
        );
        candidates = (await getDocs(q)).docs;
      } catch (e) {
        console.warn("room lookup failed:", (e as Error)?.message);
        candidates = [];
      }

      for (const doc of candidates) {
        const data = doc.data();
        if (!validSdp(data?.offer)) continue;
        try {
          // Callee — receives the caller's data channel.
          await peerConnection.setRemoteDescription(
            data.offer as RTCSessionDescriptionInit
          );
          const answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);
          // Atomic claim: losers get "room-taken" and try the next room.
          const { generateId, ownerUid } = await claimRoom(
            doc.ref,
            { type: answer.type, sdp: answer.sdp },
            user.uid
          );
          setRole("callee");
          info.Ref = doc.ref;
          info.Id = doc.ref.id;
          sendCandidateToRemotePeer(
            generateId,
            peerConnection,
            "callee",
            ownerUid
          );
          listenToRemoteCandidate(generateId, peerConnection, "callee");
          trackActiveRoom(info, generateId, ownerUid, user.uid);
          return;
        } catch (e) {
          const msg = ((e as Error)?.message ?? "").toLowerCase();
          // Room taken / gone / malformed → try next candidate.
          // Permission-denied here means a stale room from before the
          // hardened rules (no createdAt) — skip it too; if rules are
          // genuinely broken, sendOffer below fails and surfaces the error.
          if (
            msg.includes("room-taken") ||
            msg.includes("room-gone") ||
            msg.includes("room-malformed") ||
            msg.includes("permission") ||
            msg.includes("insufficient")
          ) {
            continue;
          }
          throw e;
        }
      }

      await sendOffer(info, peerConnection);
    },
    [sendOffer, sendCandidateToRemotePeer, listenToRemoteCandidate, trackActiveRoom, claimRoom]
  );

  /* ------------------------------ Peer factory ---------------------------- */
  const createPeer = useCallback(async () => {
    const peerConnection = new RTCPeerConnection(ICE_SERVERS);

    peerConnection.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream && mountedRef.current) setRemoteStream(stream);
      if (!connectedRef.current) {
        connectedRef.current = true;
        clearSearchTimer();
        if (mountedRef.current) setStatus("connected");
      }
    };

    // Callee receives the caller's data channel here.
    peerConnection.ondatachannel = (event) => {
      wireDataChannel(event.channel);
    };

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      if (state === "connected") {
        clearPeerLeftTimer();
        clearSearchTimer();
        if (!connectedRef.current) {
          connectedRef.current = true;
          if (mountedRef.current) setStatus("connected");
        }
      } else if (state === "failed") {
        if (!intentionalCloseRef.current) failSession();
      } else if (state === "closed") {
        if (!intentionalCloseRef.current) handlePeerLeft();
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      const state = peerConnection.iceConnectionState;
      if (state === "disconnected") {
        clearPeerLeftTimer();
        peerLeftTimerRef.current = setTimeout(() => {
          if (!intentionalCloseRef.current) handlePeerLeft();
        }, 5000);
      } else if (
        state === "connected" ||
        state === "completed" ||
        state === "failed"
      ) {
        if (state === "failed") {
          if (!intentionalCloseRef.current) failSession();
          return;
        }
        clearPeerLeftTimer();
      }
    };

    // Attach local tracks: shared audio + the peer-bound video original
    // (dark unless the camera is on and verified — black flows, never a
    // frozen frame, no sender surgery needed).
    const local = localStreamRef.current;
    if (local) {
      local.getAudioTracks().forEach((track) => {
        try {
          peerConnection.addTrack(track, local);
        } catch {
          /* track may already be attached */
        }
      });
    }
    const peerVideo = peerVideoTrackRef.current;
    if (peerVideo && peerVideo.readyState === "live") {
      try {
        if (local) peerConnection.addTrack(peerVideo, local);
        else peerConnection.addTrack(peerVideo);
      } catch {
        /* track may already be attached */
      }
    }

    return peerConnection;
  }, [wireDataChannel, clearPeerLeftTimer, clearSearchTimer, handlePeerLeft, failSession]);

  /* ------------------------------- Hang up -------------------------------- */
  /**
   * Disconnects the peer connection FIRST (immediate, local), then finishes
   * Firestore cleanup in the background so the UI never blocks on the network.
   */
  const hangUp = useCallback(
    (opts: { keepCamera?: boolean } = {}) => {
      // Invalidate any in-flight start() for the previous session.
      sessionRef.current += 1;
      intentionalCloseRef.current = true;
      clearAllTimers();
      teardownPeerSync();

      // Capture room state for background cleanup, then clear refs.
      const captured = {
        info: { ...roomInfoRef.current },
        room: { ...activeRoomRef.current },
      };
      roomInfoRef.current = { Ref: null, Id: null };
      activeRoomRef.current = { roomId: null, ownerUid: null, joinedUid: null };
      if (mountedRef.current) setRole(null);

      // Camera handling (peer original included — it outlives preview).
      if (!opts.keepCamera) {
        stopLocalStream();
      }

      // Background Firestore cleanup (fire and forget).
      cleanupRemoteRoomData(captured).catch((e) =>
        console.warn("background cleanup failed:", (e as Error)?.message)
      );

      // Delayed ICE re-sweep: the remote peer may still be alive for a
      // second and write candidates after our first pass. Room doc is
      // already gone, so the orphan-ICE rule lets anyone reap them.
      const leftRoomId = captured.room.roomId || captured.info.Id;
      if (leftRoomId) {
        clearResweepTimer();
        resweepTimerRef.current = setTimeout(() => {
          resweepTimerRef.current = null;
          if (!mountedRef.current) return;
          deleteCollectionDocs(leftRoomId + "caller").catch(() => {});
          deleteCollectionDocs(leftRoomId + "callee").catch(() => {});
        }, RESWEEP_DELAY_MS);
      }

      // Reset the manual-close guard shortly after, so a fresh start is clean.
      clearGuardTimer();
      guardTimerRef.current = setTimeout(() => {
        intentionalCloseRef.current = false;
        guardTimerRef.current = null;
      }, 300);
    },
    [clearAllTimers, clearGuardTimer, clearResweepTimer, teardownPeerSync, cleanupRemoteRoomData, deleteCollectionDocs, stopLocalStream]
  );

  /* --------- Fresh-session retry on failure / timeout --------- */

  const scheduleFreshRetry = useCallback(
    (session: number, reason: string) => {
      if (!mountedRef.current) return;
      if (sessionRef.current !== session) return;
      if (retryCountRef.current >= MAX_AUTO_RETRIES) {
        teardownPeerSync();
        roomInfoRef.current = { Ref: null, Id: null };
        activeRoomRef.current = { roomId: null, ownerUid: null, joinedUid: null };
        if (mountedRef.current) {
          setStatus("idle");
          setError(
            `Connection ${reason}. Check your network and try again.`
          );
          setCanRetryError(true);
        }
        return;
      }
      retryCountRef.current += 1;
      // Full teardown (keep camera so we don't re-prompt), then fresh session.
      hangUp({ keepCamera: true });
      clearRetryTimer();
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        if (!mountedRef.current) return;
        void startRef.current({ resetRetries: false, force: true });
      }, RETRY_DELAY_MS);
    },
    [hangUp, clearRetryTimer, teardownPeerSync]
  );

  // Keep mutable retry/start refs in sync via effects (no render-time writes).
  useEffect(() => {
    scheduleFreshRetryRef.current = scheduleFreshRetry;
  }, [scheduleFreshRetry]);

  const armSearchTimeout = useCallback(
    (session: number) => {
      clearSearchTimer();
      searchTimerRef.current = setTimeout(() => {
        searchTimerRef.current = null;
        if (!mountedRef.current) return;
        if (sessionRef.current !== session) return;
        if (connectedRef.current) return;
        // Still searching after timeout → fresh session retry.
        scheduleFreshRetry(session, "timed out");
      }, SEARCH_TIMEOUT_MS);
    },
    [clearSearchTimer, scheduleFreshRetry]
  );

  /* -------------------------------- Start --------------------------------- */
  const start = useCallback(
    async (opts: { resetRetries?: boolean; force?: boolean } = {}) => {
      const resetRetries = opts.resetRetries ?? true;
      const force = opts.force ?? false;
      // User-initiated abuse gates (internal auto-retries bypass via force).
      if (!force) {
        const now = Date.now();
        if (now - lastStartAtRef.current < START_COOLDOWN_MS) {
          showNotice("Give it a sec before searching again.");
          return;
        }
        startTimesRef.current = startTimesRef.current.filter(
          (t) => now - t < START_WINDOW_MS
        );
        if (startTimesRef.current.length >= MAX_STARTS_PER_MIN) {
          showNotice("Too many attempts — wait a minute, then retry.");
          return;
        }
        lastStartAtRef.current = now;
        startTimesRef.current.push(now);
      }
      clearRetryTimer();
      clearSearchTimer();
      dismissError();
      if (resetRetries) {
        retryCountRef.current = 0;
        setPermissionError(null);
        setFaceEnablePrompt(false);
      }
      setMessages([]);
      setStatus("searching");
      connectedRef.current = false;
      intentionalCloseRef.current = false;
      const session = sessionRef.current + 1;
      sessionRef.current = session;
      armSearchTimeout(session);

      try {
        await ensureAnonymousAuth();
        if (sessionRef.current !== session || !mountedRef.current) return;
        await ensureCamera();
        if (sessionRef.current !== session || !mountedRef.current) return;

        // Janitor pass, now authed — clears stale rooms right before we
        // look for a match, so we never join a corpse.
        sweepStaleRooms().catch(() => {});

        const peerConnection = await createPeer();
        if (sessionRef.current !== session || !mountedRef.current) {
          try {
            peerConnection.close();
          } catch {
            /* noop */
          }
          return;
        }
        peerRef.current = peerConnection;

        const info: RoomInfo = { Ref: null, Id: null };
        await joinCall(info, peerConnection);
        if (sessionRef.current !== session || !mountedRef.current) return;
      } catch (e) {
        if (sessionRef.current !== session || !mountedRef.current) return;
        const err = e as DOMException & {
          code?: string;
          message?: string;
          __permKind?: PermissionKind;
        };

        // 1. Camera / mic permission & device failures → dedicated dialog.
        // Match ONLY getUserMedia DOMException names (or our own __permKind
        // flag). Never match on message text: Firestore denials say
        // "Missing or insufficient permissions" and must NOT land here —
        // that misclassification showed the camera-blocked popup right
        // after the user granted access.
        const permNames = new Set([
          "NotAllowedError",
          "SecurityError",
          "NotFoundError",
          "OverconstrainedError",
          "NotReadableError",
          "AbortError",
        ]);
        if (err?.__permKind || (err?.name && permNames.has(err.name))) {
          // Full detail (name + message + constraint) — the name alone
          // can't distinguish "locked by another app" from driver failure.
          console.warn("camera failed:", {
            name: (err as DOMException)?.name,
            message: (err as Error)?.message,
            constraint: (err as unknown as OverconstrainedError)?.constraint,
          });
          hangUp({ keepCamera: false });
          setStatus("idle");
          let info = classifyCameraError(e);
          if (err?.__permKind === "unsupported") {
            info = {
              kind: "unsupported",
              title: "Camera not supported",
              message:
                "This browser can't access camera/mic (getUserMedia missing). Use a modern browser over HTTPS.",
              canReprompt: false,
            };
          } else if (err?.__permKind === "insecure") {
            info = {
              kind: "insecure",
              title: "Insecure context",
              message:
                "Camera/mic require HTTPS or localhost. Serve the app securely, then try again.",
              canReprompt: false,
            };
          } else if (info.kind === "denied") {
            // Label which device is actually blocked when the API tells us.
            try {
              const states = await queryDevicePermissionStates();
              const camDenied = states.camera === "denied";
              const micDenied = states.mic === "denied";
              if (camDenied && !micDenied) {
                info = {
                  ...info,
                  title: "Camera access blocked",
                  message:
                    "Camera is blocked but mic looks OK. Allow camera in the site settings, then try again.",
                };
              } else if (micDenied && !camDenied) {
                info = {
                  ...info,
                  title: "Microphone access blocked",
                  message:
                    "Microphone is blocked but camera looks OK. Allow mic in the site settings, then try again.",
                };
              }
            } catch {
              /* keep generic denied copy */
            }
          }
          setPermissionError(info);
          return;
        }

        // 2. Retryable network / signaling failure → fresh session retry.
        console.warn("start failed:", err?.code || err?.message || err);
        if (
          isRetryableStartError(e) &&
          retryCountRef.current < MAX_AUTO_RETRIES
        ) {
          retryCountRef.current += 1;
          hangUp({ keepCamera: true });
          clearRetryTimer();
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            if (!mountedRef.current) return;
            if (sessionRef.current !== session) {
              // hangUp bumped the session; start a new one.
              void startRef.current({ resetRetries: false, force: true });
              return;
            }
            void startRef.current({ resetRetries: false, force: true });
          }, RETRY_DELAY_MS);
          return;
        }

        // 3. Anything else → generic, friendly message — no internals leaked.
        hangUp({ keepCamera: false });
        setStatus("idle");
        setError("Sorry, something bad just happened. Try again after a moment.");
        setCanRetryError(true);
      }
    },
    [
      ensureAnonymousAuth,
      ensureCamera,
      createPeer,
      joinCall,
      hangUp,
      armSearchTimeout,
      clearRetryTimer,
      clearSearchTimer,
      dismissError,
      showNotice,
      sweepStaleRooms,
    ]
  );
  useEffect(() => {
    startRef.current = start;
  }, [start]);

  /** Manual "try again" for the generic error dialog (fresh session). */
  const retryConnection = useCallback(() => {
    dismissError();
    void start({ resetRetries: true, force: true });
  }, [dismissError, start]);

  const dismissFaceEnablePrompt = useCallback(
    () => setFaceEnablePrompt(false),
    []
  );

  /** "Try again" for the permission dialog (re-prompts getUserMedia). */
  const retryPermissions = useCallback(() => {
    setPermissionError(null);
    // Tear down any stale tracks first so the re-request is a truly fresh
    // prompt — reusing a dead/old stream is what got users "stuck".
    stopLocalStream();
    void start({ resetRetries: true, force: true });
  }, [start, stopLocalStream]);

  const nextPerson = useCallback(async () => {
    // Drop the current peer (keep the camera), then search again.
    hangUp({ keepCamera: true });
    await start({ resetRetries: true });
  }, [hangUp, start]);

  const disconnect = useCallback(() => {
    hangUp({ keepCamera: false });
    setStatus("idle");
  }, [hangUp]);

  /* ------------------------------ Tear down on unmount -------------------- */
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      intentionalCloseRef.current = true;
      clearAllTimers();
      const pc = peerRef.current;
      peerRef.current = null;
      if (pc) {
        try {
          pc.onicecandidate = null;
          pc.ontrack = null;
          pc.ondatachannel = null;
          pc.onconnectionstatechange = null;
          pc.oniceconnectionstatechange = null;
          pc.close();
        } catch {
          /* noop */
        }
      }
      if (channelRef.current) {
        try {
          channelRef.current.onopen = null;
          channelRef.current.onclose = null;
          channelRef.current.onmessage = null;
          channelRef.current.onerror = null;
          channelRef.current.close();
        } catch {
          /* noop */
        }
        channelRef.current = null;
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            /* noop */
          }
        });
        localStreamRef.current = null;
      }
      if (peerVideoTrackRef.current) {
        try {
          peerVideoTrackRef.current.stop();
        } catch {
          /* noop */
        }
        peerVideoTrackRef.current = null;
      }
      const captured = {
        info: { ...roomInfoRef.current },
        room: { ...activeRoomRef.current },
      };
      unsubsRef.current.forEach((u) => {
        try {
          u();
        } catch {
          /* noop */
        }
      });
      unsubsRef.current = [];
      // Best-effort orphan cleanup; fire and forget on unmount.
      cleanupRemoteRoomData(captured).catch(() => {});
    };
  }, [clearAllTimers, cleanupRemoteRoomData]);

  return {
    status,
    role,
    localStream,
    remoteStream,
    messages,
    channelOpen,
    error,
    canRetryError,
    dismissError,
    retryConnection,
    permissionError,
    dismissPermissionError,
    retryPermissions,
    notice,
    notify,
    faceEnablePrompt,
    dismissFaceEnablePrompt,
    cameraOn,
    micOn,
    setCameraEnabled,
    setMicEnabled,
    videoDevices,
    audioDevices,
    activeVideoDeviceId,
    activeAudioDeviceId,
    refreshDevices,
    switchDevice,
    start,
    disconnect,
    nextPerson,
    sendMessage,
  };
}
