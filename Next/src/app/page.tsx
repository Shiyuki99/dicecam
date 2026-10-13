"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CameraOff,
  Github,
  Loader2,
  MessageCircle,
  Mic,
  MicOff,
  PhoneOff,
  Play,
  RefreshCw,
  ScanFace,
  Send,
  ShieldAlert,
  Shuffle,
  Signal,
  UserX,
  Video,
  VideoOff,
  Volume2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useRandomChat,
  type ChatStatus,
} from "@/hooks/use-random-chat";
import { useFaceGate } from "@/hooks/use-face-gate";

const GITHUB_URL = "https://github.com/Shiyuki99/dicecam";

export default function Home() {
  const chat = useRandomChat();
  // Populate the device pickers whenever the permission dialog opens.
  useEffect(() => {
    if (chat.permissionError) void chat.refreshDevices();
  }, [chat.permissionError, chat.refreshDevices]);
  return (
    <div className="relative h-[100dvh] overflow-hidden bg-zinc-950 text-zinc-100">
      {/* Ambient background glows */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(60% 50% at 85% -5%, rgba(16,185,129,0.16) 0%, rgba(16,185,129,0) 60%), radial-gradient(50% 50% at 0% 100%, rgba(244,63,94,0.10) 0%, rgba(244,63,94,0) 55%)",
        }}
      />

      <DesktopView chat={chat} />
      <MobileView chat={chat} />

      {/* Permission dialog: camera/mic blocked, with re-prompt */}
      <Dialog
        open={!!chat.permissionError}
        onOpenChange={(o) => {
          if (!o) chat.dismissPermissionError();
        }}
      >
        <DialogContent className="border-white/10 bg-zinc-900 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-zinc-100">
              {chat.permissionError?.kind === "no-device" ? (
                <CameraOff className="size-4 text-amber-400" />
              ) : (
                <ShieldAlert className="size-4 text-amber-400" />
              )}
              {chat.permissionError?.title ?? "Permission needed"}
            </DialogTitle>
            <DialogDescription className="text-zinc-400">
              {chat.permissionError?.message}
            </DialogDescription>
          </DialogHeader>
          <details className="rounded-lg border border-white/10 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
            <summary className="cursor-pointer font-medium text-zinc-200">
              How to enable camera / mic
            </summary>
            <ul className="mt-2 list-disc space-y-1 pl-4">
              <li>
                Chrome (desktop): click the camera icon in the address bar
                → Allow → reload.
              </li>
              <li>
                Chrome (Android): tap the lock icon → Permissions → Camera /
                Microphone → Allow.
              </li>
              <li>
                Safari (iOS): Settings → Safari → Camera &amp; Microphone →
                Allow. Then reload this page.
              </li>
              <li>
                Firefox: click the camera icon in the address bar → Allow.
              </li>
            </ul>
          </details>
          <PermissionDevicePickers chat={chat} />
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => window.location.reload()}
              className="text-zinc-300 hover:bg-white/10 hover:text-zinc-100"
            >
              Reload page
            </Button>
            <Button
              variant="ghost"
              onClick={chat.dismissPermissionError}
              className="text-zinc-300 hover:bg-white/10 hover:text-zinc-100"
            >
              Not now
            </Button>
            <Button
              onClick={chat.retryPermissions}
              className="gap-2 bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
            >
              <RefreshCw className="size-4" />
              Try again
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Shared error modal (connection failures offer a fresh retry) */}
      <Dialog
        open={!!chat.error}
        onOpenChange={(o) => {
          if (!o) chat.dismissError();
        }}
      >
        <DialogContent className="border-white/10 bg-zinc-900 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-zinc-100">
              <Signal className="size-4 text-rose-400" />
              Something went wrong
            </DialogTitle>
            <DialogDescription className="text-zinc-400">
              {chat.error}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={chat.dismissError}
              className="text-zinc-300 hover:bg-white/10 hover:text-zinc-100"
            >
              Dismiss
            </Button>
            {chat.canRetryError && (
              <Button
                onClick={chat.retryConnection}
                className="gap-2 bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
              >
                <RefreshCw className="size-4" />
                Try again
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Transient rate-limit toast (auto-dismisses, no action needed) */}
      {chat.notice && (
        <div className="pointer-events-none absolute bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-full border border-white/10 bg-zinc-900/95 px-4 py-2 text-xs font-medium text-zinc-200 shadow-xl backdrop-blur">
          {chat.notice}
        </div>
      )}

      {/* Face gate: single instance (both views stay mounted, one hidden) */}
      <FaceGate chat={chat} />

      {/* First-open disclaimer (blocks UI until approved) */}
      <DisclaimerDialog />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

// Attach a stream, or fully clear the element. Assigning srcObject = null
// alone leaves the last frame painted (frozen ghost on disconnect) —
// pause + drop src + load() resets to blank.
function setVideoStream(v: HTMLVideoElement | null, stream: MediaStream | null) {
  if (!v) return;
  if (!stream) {
    try {
      v.pause();
    } catch {
      /* noop */
    }
    v.removeAttribute("src");
    v.srcObject = null;
    try {
      v.load();
    } catch {
      /* noop */
    }
    return;
  }
  if (v.srcObject !== stream) v.srcObject = stream;
}

// Any user gesture (Start tap included) counts toward the autoplay policy,
// so retry remote playback on every tap/keypress — the lock usually
// releases long before the overlay is ever needed (it stays as fallback).
function useRemoteAudioUnlock(
  ref: React.RefObject<HTMLVideoElement | null>,
  stream: MediaStream | null,
  setBlocked: (b: boolean) => void
) {
  useEffect(() => {
    const unlock = () => {
      const v = ref.current;
      if (!v || !stream) return;
      try {
        v.muted = false;
        const p = v.play() as unknown as Promise<void> | undefined;
        if (p && typeof p.then === "function") {
          p.then(
            () => setBlocked(false),
            () => {}
          );
        }
      } catch {
        /* overlay stays */
      }
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [ref, stream, setBlocked]);
}

function statusConfig(status: ChatStatus, channelOpen: boolean) {
  switch (status) {
    case "idle":
      return {
        label: "Idle",
        dot: "bg-zinc-500",
        text: "text-zinc-400",
        pulse: false,
      };
    case "searching":
      return {
        label: "Searching",
        dot: "bg-amber-400",
        text: "text-amber-300",
        pulse: true,
      };
    case "connected":
      return {
        label: channelOpen ? "Connected" : "Connecting",
        dot: "bg-emerald-400",
        text: "text-emerald-300",
        pulse: !channelOpen,
      };
    case "peer-left":
      return {
        label: "Stranger left",
        dot: "bg-rose-400",
        text: "text-rose-300",
        pulse: false,
      };
  }
}

function StatusPill({
  status,
  channelOpen,
}: {
  status: ChatStatus;
  channelOpen: boolean;
}) {
  const c = statusConfig(status, channelOpen);
  return (
    <div
      className={`flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium ${c.text}`}
    >
      <span className="relative flex size-2">
        {c.pulse && (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${c.dot}`}
          />
        )}
        <span className={`relative inline-flex size-2 rounded-full ${c.dot}`} />
      </span>
      {c.label}
    </div>
  );
}

function RemoteOverlay({
  status,
  hasRemote,
}: {
  status: ChatStatus;
  hasRemote: boolean;
}) {
  if (status === "connected" && hasRemote) return null;

  let content: React.ReactNode = null;

  if (status === "searching") {
    content = (
      <>
        <Loader2 className="mb-4 size-10 animate-spin text-emerald-400" />
        <p className="text-lg font-semibold text-zinc-100">
          Looking for someone to chat with…
        </p>
        <p className="mt-1 text-sm text-zinc-500">
          Hang tight, we’re finding you a match.
        </p>
      </>
    );
  } else if (status === "peer-left") {
    content = (
      <>
        <UserX className="mb-4 size-12 text-rose-400" />
        <p className="text-lg font-semibold text-zinc-100">
          Stranger disconnected
        </p>
        <p className="mt-1 text-sm text-zinc-500">
          Hit <span className="font-medium text-zinc-300">Next</span> to meet
          someone new.
        </p>
      </>
    );
  } else if (status === "connected" && !hasRemote) {
    content = (
      <>
        <Loader2 className="mb-4 size-8 animate-spin text-emerald-400" />
        <p className="text-sm text-zinc-400">Establishing connection…</p>
      </>
    );
  } else {
    content = (
      <>
        <div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-white/5 text-zinc-500 ring-1 ring-white/10">
          <VideoOff className="size-8" />
        </div>
        <p className="text-lg font-semibold text-zinc-100">Ready to connect</p>
        <p className="mt-1 text-sm text-zinc-500">
          Press <span className="font-medium text-emerald-400">Start</span> to
          meet someone new.
        </p>
      </>
    );
  }

  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-zinc-950/40 px-6 text-center backdrop-blur-[2px]">
      {content}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* First-open disclaimer (notice + approve, remembered)               */
/* ------------------------------------------------------------------ */

const DISCLAIMER_KEY = "dicecam-disclaimer-v1";

function useDisclaimer() {
  // Default closed on server prerender; effect opens it on mount if needed
  // (avoids hydration mismatch).
  const [show, setShow] = useState(false);
  useEffect(() => {
    try {
      // Mount-gated localStorage read is the intended use of this pattern.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (localStorage.getItem(DISCLAIMER_KEY) !== "1") setShow(true);
    } catch {
      setShow(true);
    }
  }, []);
  const approve = useCallback(() => {
    try {
      localStorage.setItem(DISCLAIMER_KEY, "1");
    } catch {
      /* private mode — popup returns next visit, harmless */
    }
    setShow(false);
  }, []);
  return { show, approve };
}

function DisclaimerDialog() {
  const { show, approve } = useDisclaimer();
  return (
    <Dialog open={show}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        className="border-white/10 bg-zinc-900 text-zinc-100"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-zinc-100">
            <ShieldAlert className="size-4 text-emerald-400" />
            Before you start
          </DialogTitle>
          <DialogDescription className="text-zinc-400">
            Quick notice — approve to continue.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-2 pl-5 text-sm text-zinc-300">
          <li>
            This website is not responsible for any content or behavior that
            appears on it.
          </li>
          <li>
            No personal data, info, or footage is stored or processed —
            connections are end-to-end, peer-to-peer.
          </li>
          <li>
            Your public IP is exposed by the STUN/WebRTC protocol — use a VPN
            if you&apos;re a privacy guy (like 0xAim).
          </li>
          <li>Enjoy — this is only for fun.</li>
        </ul>
        <p className="text-xs text-zinc-500">
          Want to check the code? It&apos;s on{" "}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="text-emerald-400 underline hover:text-emerald-300"
          >
            GitHub
          </a>
          .
        </p>
        <DialogFooter>
          <Button
            onClick={approve}
            className="gap-2 bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
          >
            Approve &amp; Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Permission-dialog device pickers (wrong camera/mic re-grant)       */
/* ------------------------------------------------------------------ */

function PermissionDevicePickers({
  chat,
}: {
  chat: ReturnType<typeof useRandomChat>;
}) {
  if (chat.videoDevices.length === 0 && chat.audioDevices.length === 0) {
    return null;
  }
  const selectCls =
    "mt-1 w-full rounded-lg border border-white/10 bg-zinc-950/60 px-2 py-1.5 text-xs text-zinc-200 focus:border-emerald-500/50 focus:outline-none";
  const onPick = (kind: "video" | "audio", deviceId: string) => {
    if (!deviceId) return;
    void chat.switchDevice(kind, deviceId).then((ok) => {
      if (!ok) chat.notify("Couldn't switch to that device.");
    });
  };
  return (
    <div className="space-y-2 rounded-lg border border-white/10 bg-zinc-950/60 px-3 py-2">
      <p className="text-xs font-medium text-zinc-200">
        Wrong camera or mic? Pick another, then hit Try again.
      </p>
      {chat.videoDevices.length > 0 && (
        <label className="block text-xs text-zinc-400">
          Camera
          <select
            value={chat.activeVideoDeviceId ?? ""}
            onChange={(e) => onPick("video", e.target.value)}
            className={selectCls}
          >
            <option value="" disabled>
              Select camera…
            </option>
            {chat.videoDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {chat.audioDevices.length > 0 && (
        <label className="block text-xs text-zinc-400">
          Microphone
          <select
            value={chat.activeAudioDeviceId ?? ""}
            onChange={(e) => onPick("audio", e.target.value)}
            className={selectCls}
          >
            <option value="" disabled>
              Select microphone…
            </option>
            {chat.audioDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Face gate (idle on no-face + "show your face" popup)               */
/* ------------------------------------------------------------------ */

function FaceGate({ chat }: { chat: ReturnType<typeof useRandomChat> }) {
  // Track whenever the camera is live — connected or not. Live call with
  // no face → idle + popup. Idle preview with no face → camera pauses
  // itself (popup suppressed, toast explains) until a face is back.
  const active = !!chat.localStream && chat.cameraOn;
  const timeoutActionRef = useRef<() => void>(() => {});
  const gateRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    timeoutActionRef.current = () => {
      if (chat.status === "connected") {
        chat.disconnect();
      } else {
        gateRef.current?.();
      }
    };
  });
  const stableTimeout = useCallback(() => timeoutActionRef.current(), []);
  const gate = useFaceGate({
    stream: chat.localStream,
    active,
    onTimeout: stableTimeout,
  });
  // Idle-path action, registered for the timeout above. The hook fires
  // setFacePopup(true) just before onTimeout, so dismissing here batches
  // the popup away (never flashes) while the toast explains the pause.
  useEffect(() => {
    gateRef.current = () => {
      gate.dismissFacePopup();
      void chat.setCameraEnabled(false);
      chat.notify("Camera paused — show your face to turn it back on.");
    };
  });

  const restart = () => {
    gate.dismissFacePopup();
    void chat.start();
  };

  if (!gate.supported) return null;
  return (
    <>
      {gate.warnSecs !== null && active && (
        <div className="pointer-events-none absolute left-1/2 top-16 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-500/30 bg-zinc-900/95 px-4 py-2 text-xs font-medium text-amber-200 shadow-xl backdrop-blur">
          <ScanFace className="size-4" />
          Show your face to stay connected ({gate.warnSecs}s)
        </div>
      )}

      <Dialog
        open={gate.facePopup}
        onOpenChange={(o) => {
          if (!o) gate.dismissFacePopup();
        }}
      >
        <DialogContent className="border-amber-500/40 bg-zinc-900 text-zinc-100 shadow-2xl shadow-amber-500/10 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3 text-xl text-zinc-50">
              <span className="flex size-11 shrink-0 animate-pulse items-center justify-center rounded-xl bg-amber-500/15 ring-1 ring-amber-500/40">
                <ScanFace className="size-6 text-amber-300" />
              </span>
              Show your face
            </DialogTitle>
            <DialogDescription className="text-sm text-zinc-400">
              No face detected — you were idled. Show your face so you can
              continue.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={gate.dismissFacePopup}
              className="text-zinc-300 hover:bg-white/10 hover:text-zinc-100"
            >
              Not now
            </Button>
            <Button
              onClick={restart}
              className="gap-2 bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
            >
              <Play className="size-4 fill-current" />
              Start again
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={chat.faceEnablePrompt}
        onOpenChange={(o) => {
          if (!o) chat.dismissFaceEnablePrompt();
        }}
      >
        <DialogContent className="border-amber-500/40 bg-zinc-900 text-zinc-100 shadow-2xl shadow-amber-500/10 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3 text-xl text-zinc-50">
              <span className="flex size-11 shrink-0 animate-pulse items-center justify-center rounded-xl bg-amber-500/15 ring-1 ring-amber-500/40">
                <ScanFace className="size-6 text-amber-300" />
              </span>
              Show your face
            </DialogTitle>
            <DialogDescription className="text-sm text-zinc-400">
              Please show your face to enable the camera.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={chat.dismissFaceEnablePrompt}
              className="gap-2 bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
            >
              Got it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Local device toggles (camera off / mic off / both = text-only)     */
/* ------------------------------------------------------------------ */

function DeviceToggles({
  chat,
  compact,
}: {
  chat: ReturnType<typeof useRandomChat>;
  compact?: boolean;
}) {
  const btn = compact ? "size-6" : "size-8";
  const icon = compact ? "size-3.5" : "size-4";
  const on =
    "border-white/10 bg-black/55 text-zinc-200 hover:bg-black/75";
  const off =
    "border-rose-500/50 bg-rose-500/25 text-rose-200 hover:bg-rose-500/35";
  return (
    <div className="absolute bottom-2 right-2 z-10 flex gap-1.5">
      <button
        type="button"
        onClick={(e) => {
          // Don't bubble to the stage's zoom toggle (mobile): tapping a
          // device button must never flip the video fit.
          e.stopPropagation();
          void chat.setCameraEnabled(!chat.cameraOn);
        }}
        title={chat.cameraOn ? "Turn camera off" : "Turn camera on"}
        aria-label={chat.cameraOn ? "Turn camera off" : "Turn camera on"}
        aria-pressed={!chat.cameraOn}
        className={`flex ${btn} items-center justify-center rounded-lg border backdrop-blur transition active:scale-95 ${chat.cameraOn ? on : off}`}
      >
        {chat.cameraOn ? (
          <Video className={icon} />
        ) : (
          <VideoOff className={icon} />
        )}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          chat.setMicEnabled(!chat.micOn);
        }}
        title={chat.micOn ? "Mute microphone" : "Unmute microphone"}
        aria-label={chat.micOn ? "Mute microphone" : "Unmute microphone"}
        aria-pressed={!chat.micOn}
        className={`flex ${btn} items-center justify-center rounded-lg border backdrop-blur transition active:scale-95 ${chat.micOn ? on : off}`}
      >
        {chat.micOn ? <Mic className={icon} /> : <MicOff className={icon} />}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Desktop (unchanged sidebar layout)                                  */
/* ------------------------------------------------------------------ */

function DesktopView({ chat }: { chat: ReturnType<typeof useRandomChat> }) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  // PC browsers often block play-with-audio on late-attached streams
  // (autoplay policy) — explicit play() + tap fallback unlocks it.
  const [audioBlocked, setAudioBlocked] = useState(false);
  useRemoteAudioUnlock(remoteVideoRef, chat.remoteStream, setAudioBlocked);

  // Camera off detaches the preview entirely (black element, not a live
  // feed under the overlay) so "off" reads as off.
  useEffect(() => {
    setVideoStream(
      localVideoRef.current,
      chat.cameraOn ? chat.localStream : null
    );
  }, [chat.localStream, chat.cameraOn]);

  useEffect(() => {
    const v = remoteVideoRef.current;
    if (!v) return;
    if (!chat.remoteStream) {
      setVideoStream(v, null);
      return;
    }
    setVideoStream(v, chat.remoteStream);
    let cancelled = false;
    void (async () => {
      try {
        v.muted = false;
        await v.play();
        if (!cancelled) setAudioBlocked(false);
      } catch {
        if (!cancelled) setAudioBlocked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chat.remoteStream]);

  const unblockAudio = () => {
    const v = remoteVideoRef.current;
    if (!v) return;
    try {
      v.muted = false;
      const p = v.play() as unknown as Promise<void> | undefined;
      if (p && typeof p.then === "function") {
        p.then(
          () => setAudioBlocked(false),
          () => setAudioBlocked(true)
        );
      } else {
        setAudioBlocked(false);
      }
    } catch {
      setAudioBlocked(true);
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.messages]);

  const started = chat.status !== "idle";
  const canChat = chat.channelOpen && chat.status === "connected";

  // Global desktop shortcuts: double Enter = next (first arms, second
  // within 2s skips), Escape = disconnect. Ignored while typing in the
  // chat input so Enter can send messages.
  const nextArmedRef = useRef(false);
  const nextArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!started) {
      nextArmedRef.current = false;
      return;
    }
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (nextArmedRef.current) {
          nextArmedRef.current = false;
          if (nextArmTimerRef.current) clearTimeout(nextArmTimerRef.current);
          void chat.nextPerson();
        } else {
          nextArmedRef.current = true;
          chat.notify("Press Enter again to skip.");
          nextArmTimerRef.current = setTimeout(() => {
            nextArmedRef.current = false;
          }, 2000);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        chat.disconnect();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      if (nextArmTimerRef.current) clearTimeout(nextArmTimerRef.current);
    };
  }, [started, chat.nextPerson, chat.disconnect, chat.notify]);

  const onSend = () => {
    if (chat.sendMessage(draft)) setDraft("");
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="relative z-10 hidden h-full min-h-0 lg:flex lg:flex-col">
      <header className="flex shrink-0 items-center justify-between px-6 py-3">
        <div className="flex items-center gap-2.5">
          <img
            src="/dicecam-logo.svg"
            alt="DiceCam"
            className="size-12 rounded-xl"
          />
          <div className="leading-tight">
            <h1 className="text-lg font-semibold tracking-tight">DiceCam</h1>
            <p className="text-xs text-zinc-500">Random video chat</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Open GitHub repo"
            title="Open GitHub repo"
            className="flex size-9 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100 active:scale-95"
          >
            <Github className="size-4" />
          </a>
          <StatusPill status={chat.status} channelOpen={chat.channelOpen} />
        </div>
      </header>

      <main className="relative min-h-0 flex-1 px-6 pb-3">
        <div className="grid h-full min-h-0 grid-cols-[24rem_1fr] gap-3">
          <aside className="flex min-h-0 flex-col gap-3">
            <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/70 shadow-lg shadow-black/40">
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className="absolute inset-0 h-full w-full -scale-x-100 object-cover"
              />
              {!chat.localStream && (
                <div className="absolute inset-0 flex items-center justify-center text-zinc-600">
                  <VideoOff className="size-6" />
                </div>
              )}
              {chat.localStream && !chat.cameraOn && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-zinc-950/80 text-zinc-500">
                  <VideoOff className="size-6" />
                  <span className="text-[10px] font-medium">Camera off</span>
                </div>
              )}
              <span className="absolute left-2 top-2 z-10 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-zinc-200 backdrop-blur">
                You
              </span>
              <DeviceToggles chat={chat} />
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/50 shadow-xl shadow-black/30 backdrop-blur">
              <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2.5">
                <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                  <MessageCircle className="size-4 text-emerald-400" />
                  Chat
                </div>
                <span
                  className={`flex items-center gap-1.5 text-xs ${canChat ? "text-emerald-400" : "text-zinc-500"}`}
                >
                  <span
                    className={`size-1.5 rounded-full ${canChat ? "bg-emerald-400" : "bg-zinc-600"}`}
                  />
                  {canChat ? "Live" : "Offline"}
                </span>
              </div>

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                {chat.messages.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center px-4 text-center">
                    <MessageCircle className="mb-2 size-6 text-zinc-700" />
                    <p className="text-xs text-zinc-500">
                      {chat.status === "connected"
                        ? "Say hi to your match 👋"
                        : "Messages appear here once you’re connected."}
                    </p>
                  </div>
                ) : (
                  chat.messages.map((m) => (
                    <div
                      key={m.id}
                      className={`flex ${m.from === "me" ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[85%] break-words rounded-2xl px-3 py-1.5 text-sm leading-snug shadow-sm ${
                          m.from === "me"
                            ? "rounded-br-sm bg-emerald-500/20 text-emerald-50 ring-1 ring-emerald-500/30"
                            : "rounded-bl-sm bg-zinc-800/90 text-zinc-100 ring-1 ring-white/10"
                        }`}
                      >
                        {m.text}
                      </div>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="flex shrink-0 items-center gap-2 border-t border-white/10 p-3">
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder={canChat ? "Type a message…" : "Connect to start chatting"}
                  disabled={!canChat}
                  className="min-w-0 flex-1 border-white/10 bg-zinc-950/60 text-zinc-100 placeholder:text-zinc-600 focus-visible:border-emerald-500/50 focus-visible:ring-emerald-500/20"
                />
                <Button
                  onClick={onSend}
                  disabled={!canChat || !draft.trim()}
                  size="icon"
                  className="size-9 shrink-0 rounded-xl bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
                  aria-label="Send message"
                >
                  <Send className="size-4" />
                </Button>
              </div>
            </div>
          </aside>

          <section className="flex min-h-0 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/50 shadow-2xl shadow-black/40 backdrop-blur">
            <div className="relative aspect-video max-h-full w-full max-w-full overflow-hidden rounded-2xl bg-zinc-950/60">
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className="absolute inset-0 h-full w-full object-cover"
              />
              {audioBlocked && chat.remoteStream && (
                <button
                  type="button"
                  onClick={unblockAudio}
                  className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-zinc-950/70 backdrop-blur-sm transition hover:bg-zinc-950/60"
                >
                  <Volume2 className="size-8 text-emerald-400" />
                  <span className="text-sm font-medium text-zinc-100">
                    Tap for sound
                  </span>
                </button>
              )}
              <RemoteOverlay status={chat.status} hasRemote={!!chat.remoteStream} />
            </div>
          </section>
        </div>
      </main>

      <footer className="relative z-10 shrink-0 border-t border-white/10 bg-zinc-950/60 px-6 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-end gap-3">
          {!started ? (
            <Button
              onClick={() => chat.start()}
              size="lg"
              className="h-12 gap-2 rounded-xl bg-emerald-500 px-8 text-base font-semibold text-zinc-950 shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-400"
            >
              <Play className="size-5 fill-current" />
              Start
            </Button>
          ) : (
            <>
              <Button
                onClick={chat.nextPerson}
                size="lg"
                className="h-12 gap-2 rounded-xl bg-zinc-100 px-6 text-base font-semibold text-zinc-950 shadow-lg transition hover:bg-white"
              >
                <Shuffle className="size-5" />
                Next Person
              </Button>
              <Button
                onClick={chat.disconnect}
                size="lg"
                className="h-12 gap-2 rounded-xl bg-rose-500/90 px-6 text-base font-semibold text-white shadow-lg shadow-rose-500/20 transition hover:bg-rose-500"
              >
                <PhoneOff className="size-5" />
                Disconnect
              </Button>
            </>
          )}
        </div>
        <p className="mx-auto mt-2 max-w-4xl text-center text-[11px] text-zinc-600">
          P2P call — matched strangers can see your public IP. Use a VPN if
          you care.
        </p>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mobile (new single-screen layout)                                   */
/* ------------------------------------------------------------------ */

function MobileView({ chat }: { chat: ReturnType<typeof useRandomChat> }) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const [stopArmed, setStopArmed] = useState(false);
  const [cover, setCover] = useState(true);
  const [showHint, setShowHint] = useState(true);
  // Same autoplay-policy unlock as desktop (phones usually allow it,
  // but a late-attached stream can still start muted).
  const [audioBlocked, setAudioBlocked] = useState(false);
  useRemoteAudioUnlock(remoteVideoRef, chat.remoteStream, setAudioBlocked);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Same as desktop: camera off detaches the preview entirely.
  useEffect(() => {
    setVideoStream(
      localVideoRef.current,
      chat.cameraOn ? chat.localStream : null
    );
  }, [chat.localStream, chat.cameraOn]);

  useEffect(() => {
    const v = remoteVideoRef.current;
    if (!v) return;
    if (!chat.remoteStream) {
      setVideoStream(v, null);
      return;
    }
    setVideoStream(v, chat.remoteStream);
    let cancelled = false;
    void (async () => {
      try {
        v.muted = false;
        await v.play();
        if (!cancelled) setAudioBlocked(false);
      } catch {
        if (!cancelled) setAudioBlocked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chat.remoteStream]);

  const unblockAudio = () => {
    const v = remoteVideoRef.current;
    if (!v) return;
    try {
      v.muted = false;
      const p = v.play() as unknown as Promise<void> | undefined;
      if (p && typeof p.then === "function") {
        p.then(
          () => setAudioBlocked(false),
          () => setAudioBlocked(true)
        );
      } else {
        setAudioBlocked(false);
      }
    } catch {
      setAudioBlocked(true);
    }
  };

  useEffect(() => {
    return () => {
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    };
  }, []);

  // Brief hint on top of the camera — auto-hide after a few seconds.
  useEffect(() => {
    const t = setTimeout(() => setShowHint(false), 5000);
    return () => clearTimeout(t);
  }, []);

  // Reset transient UI (compose open, stop-armed) whenever call state changes.
  const [prevStatus, setPrevStatus] = useState(chat.status);
  if (chat.status !== prevStatus) {
    setPrevStatus(chat.status);
    setComposing(false);
    setStopArmed(false);
    // Any pending stop-confirm timer will fire later as a harmless no-op.
  }

  const started = chat.status !== "idle";
  const canChat = chat.channelOpen && chat.status === "connected";

  const openCompose = () => {
    setComposing(true);
    // Focus next tick so the input is mounted before we focus it (brings up keyboard).
    setTimeout(() => inputRef.current?.focus(), 0);
  };
  const closeCompose = () => {
    setComposing(false);
    inputRef.current?.blur();
  };

  const handleSend = () => {
    if (chat.sendMessage(draft)) setDraft("");
  };
  const onComposeKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSend();
    } else if (e.key === "Escape") {
      closeCompose();
    }
  };

  const handleStop = () => {
    if (stopArmed) {
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
      setStopArmed(false);
      chat.disconnect();
    } else {
      setStopArmed(true);
      stopTimerRef.current = setTimeout(() => setStopArmed(false), 2000);
    }
  };

  const recentMessages = chat.messages.slice(-4);
  const c = statusConfig(chat.status, chat.channelOpen);

  return (
    <div className="relative z-10 flex h-full min-h-0 flex-col lg:hidden">
      {/* Remote video stage (fills available space, with a small margin) */}
      <div className="min-h-0 flex-1 bg-zinc-950 p-2.5">
        <div
          className="relative h-full w-full cursor-pointer overflow-hidden rounded-2xl bg-zinc-950"
          onClick={() => setCover((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setCover((v) => !v);
            }
          }}
          role="button"
          tabIndex={0}
          aria-label="Toggle video zoom"
        >
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className={`absolute inset-0 h-full w-full ${cover ? "object-cover" : "object-contain"}`}
          />

          {audioBlocked && chat.remoteStream && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                unblockAudio();
              }}
              className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-zinc-950/70 backdrop-blur-sm"
            >
              <Volume2 className="size-8 text-emerald-400" />
              <span className="text-sm font-medium text-zinc-100">
                Tap for sound
              </span>
            </button>
          )}

          {/* Brief hint on top of the camera */}
          {showHint && (
            <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[11px] font-medium text-zinc-200 backdrop-blur">
              Tap video to toggle zoom
            </div>
          )}

          {/* Status chip (top-left) + repo link */}
          <div className="absolute left-3 top-3 z-20 flex flex-col items-start gap-2">
            <div
              className={`flex items-center gap-1.5 rounded-full bg-black/50 px-2.5 py-1 text-[11px] font-medium backdrop-blur ${c.text}`}
            >
              <span className="relative flex size-1.5">
                {c.pulse && (
                  <span
                    className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${c.dot}`}
                  />
                )}
                <span className={`relative inline-flex size-1.5 rounded-full ${c.dot}`} />
              </span>
              {c.label}
            </div>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="Open GitHub repo"
              title="Open GitHub repo"
              className="flex size-7 items-center justify-center rounded-full bg-black/50 text-zinc-400 backdrop-blur transition hover:text-zinc-100 active:scale-95"
            >
              <Github className="size-3.5" />
            </a>
          </div>

          {/* Local camera PiP (top-right, small) */}
          <div className="absolute right-3 top-3 z-20 w-24 overflow-hidden rounded-xl border border-white/20 bg-zinc-950/80 shadow-lg sm:w-28">
            <div className="relative aspect-video w-full">
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className="absolute inset-0 h-full w-full -scale-x-100 object-cover"
              />
              {!chat.localStream && (
                <div className="absolute inset-0 flex items-center justify-center text-zinc-600">
                  <VideoOff className="size-4" />
                </div>
              )}
              {chat.localStream && !chat.cameraOn && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-950/80 text-zinc-500">
                  <VideoOff className="size-4" />
                  <span className="text-[8px] font-medium">Off</span>
                </div>
              )}
              <span className="absolute left-1 top-1 rounded bg-black/55 px-1 py-0.5 text-[9px] font-medium text-zinc-200 backdrop-blur">
                You
              </span>
              <DeviceToggles chat={chat} compact />
            </div>
          </div>

          {/* Message bubbles overlay (bottom of video) */}
          {recentMessages.length > 0 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex flex-col items-start gap-1.5 px-3">
              {recentMessages.map((m) => (
                <div
                  key={m.id}
                  className={`max-w-[80%] break-words rounded-2xl px-2.5 py-1 text-sm leading-snug shadow-md backdrop-blur-sm ${
                    m.from === "me"
                      ? "self-end rounded-br-sm bg-emerald-500/30 text-emerald-50 ring-1 ring-emerald-500/40"
                      : "self-start rounded-bl-sm bg-zinc-900/80 text-zinc-100 ring-1 ring-white/10"
                  }`}
                >
                  {m.text}
                </div>
              ))}
            </div>
          )}

          <RemoteOverlay status={chat.status} hasRemote={!!chat.remoteStream} />
        </div>
      </div>

      {/* Controls (compose bar takes over while typing) */}
      <div className="shrink-0 border-t border-white/10 bg-zinc-950/80 backdrop-blur">
        {composing ? (
          /* Compose bar: field + send + close, sits right above the keyboard */
          <div className="flex items-center gap-2 p-3">
            <button
              type="button"
              onClick={closeCompose}
              aria-label="Close"
              className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-zinc-300 active:scale-95"
            >
              <X className="size-5" />
            </button>
            <Input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposeKeyDown}
              placeholder="Type a message…"
              inputMode="text"
              autoComplete="off"
              className="min-w-0 flex-1 border-white/10 bg-zinc-900/80 text-base text-zinc-100 placeholder:text-zinc-600 focus-visible:border-emerald-500/50 focus-visible:ring-emerald-500/20"
            />
            <Button
              onClick={handleSend}
              disabled={!draft.trim()}
              size="icon"
              className="size-10 shrink-0 rounded-xl bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
              aria-label="Send message"
            >
              <Send className="size-4" />
            </Button>
          </div>
        ) : !started ? (
          <div className="p-3">
            <Button
              onClick={() => chat.start()}
              className="h-12 w-full gap-2 rounded-xl bg-emerald-500 text-base font-semibold text-zinc-950 shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-400"
            >
              <Play className="size-5 fill-current" />
              Start
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 p-3">
            <Button
              onClick={chat.nextPerson}
              className="h-12 gap-1.5 rounded-xl bg-zinc-100 text-sm font-semibold text-zinc-950 shadow transition hover:bg-white"
            >
              <Shuffle className="size-5" />
              Next
            </Button>

            <Button
              onClick={handleStop}
              className={`h-12 gap-1.5 rounded-xl text-sm font-semibold shadow transition ${
                stopArmed
                  ? "animate-pulse bg-rose-500 text-white"
                  : "border border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
              }`}
            >
              <PhoneOff className="size-5" />
              {stopArmed ? "Confirm?" : "Stop"}
            </Button>

            <Button
              onClick={openCompose}
              disabled={!canChat}
              className="h-12 gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-sm font-semibold text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-40"
            >
              <MessageCircle className="size-5" />
              Message
            </Button>
          </div>
        )}
        <p className="px-3 pb-2 text-center text-[11px] text-zinc-600">
          P2P call — matched strangers can see your public IP. Use a VPN if
          you care.
        </p>
      </div>
    </div>
  );
}
