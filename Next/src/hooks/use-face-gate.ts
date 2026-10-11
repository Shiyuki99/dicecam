"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FaceDetector } from "@mediapipe/tasks-vision";

/**
 * On-device face gate: watches the local camera while a call is live and
 * fires when no face is visible for too long. Everything runs in-browser
 * (MediaPipe BlazeFace) — no video ever leaves the device for this check.
 *
 * Policy: sample every 1.5s → warn pill after ~6s of no-face → timeout
 * callback after ~12s continuous no-face. Counters reset the moment a
 * face is seen again. If the model/WASM fails to load (offline CDN),
 * the gate disables itself silently instead of kicking anyone.
 */

const TASKS_VISION_VERSION = "1.1.0";
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

const SAMPLE_MS = 1_500;
const WARN_AFTER_MISSES = 2; // ~3s continuous no-face → warn pill
const KICK_AFTER_MISSES = 4; // ~6s continuous no-face → timeout
const SCORE_MIN = 0.5;

// Singleton: heavy WASM + model load happens once, shared across calls.
let detectorPromise: Promise<FaceDetector> | null = null;
function getDetector(): Promise<FaceDetector> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const vision = await import("@mediapipe/tasks-vision");
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
      const opts = {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" as const },
        runningMode: "VIDEO" as const,
        minDetectionConfidence: SCORE_MIN,
      };
      try {
        return await vision.FaceDetector.createFromOptions(fileset, opts);
      } catch {
        // GPU delegate missing (older devices) → fall back to CPU.
        return await vision.FaceDetector.createFromOptions(fileset, {
          ...opts,
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" as const },
        });
      }
    })();
    detectorPromise.catch(() => {
      detectorPromise = null;
    });
  }
  return detectorPromise;
}

interface FaceGateOpts {
  stream: MediaStream | null;
  /** Gate only runs while true (e.g. camera on with a live stream). */
  active: boolean;
  onTimeout: () => void;
}

/**
 * One-shot face check against a stream. true = face visible, false = none,
 * null = detector unavailable (fail open so calls still work offline).
 *
 * Waits for real frames first (fresh grants need warm-up) and samples a few
 * frames: any positive allows. A single blind frame must never decide.
 */
export async function checkFaceOnce(
  stream: MediaStream
): Promise<boolean | null> {
  let detector: FaceDetector;
  try {
    detector = await getDetector();
  } catch {
    return null;
  }
  const video = document.createElement("video");
  video.muted = true;
  (video as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;
  video.srcObject = stream;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  try {
    await video.play().catch(() => {});
    // Wait for actual frames — up to ~4s. A fresh camera has none yet and
    // must not be mistaken for "no face" (or fail-open as "ready").
    let ready = false;
    for (let i = 0; i < 20; i += 1) {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        ready = true;
        break;
      }
      await sleep(200);
    }
    if (!ready) return null;
    // Sample up to 3 frames ~400ms apart; any face counts. Guards against
    // one bad frame wrongly blocking (or wrongly allowing) the camera.
    for (let i = 0; i < 3; i += 1) {
      if (i > 0) await sleep(400);
      try {
        if (
          detector.detectForVideo(video, performance.now()).detections.length >
          0
        ) {
          return true;
        }
      } catch {
        return null;
      }
    }
    return false;
  } catch {
    return null;
  } finally {
    try {
      video.pause();
    } catch {
      /* noop */
    }
    video.srcObject = null;
  }
}

export function useFaceGate({ stream, active, onTimeout }: FaceGateOpts) {
  const [supported, setSupported] = useState(true);
  const [warnSecs, setWarnSecs] = useState<number | null>(null);
  const [facePopup, setFacePopup] = useState(false);
  const missesRef = useRef(0);
  const onTimeoutRef = useRef(onTimeout);

  useEffect(() => {
    onTimeoutRef.current = onTimeout;
  }, [onTimeout]);

  const dismissFacePopup = useCallback(() => setFacePopup(false), []);

  useEffect(() => {
    if (!active || !stream) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let video: HTMLVideoElement | null = null;

    (async () => {
      let detector: FaceDetector;
      try {
        detector = await getDetector();
      } catch {
        if (!cancelled) setSupported(false);
        return;
      }
      if (cancelled) return;

      video = document.createElement("video");
      video.muted = true;
      (video as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        return;
      }
      if (cancelled) return;

      timer = setInterval(() => {
        if (cancelled || !video) return;
        if (video.readyState < 2 || video.videoWidth === 0) return;
        let hasFace = false;
        try {
          hasFace = detector.detectForVideo(video, performance.now()).detections.length > 0;
        } catch {
          return; // transient (timestamp skew) — keep previous state
        }
        if (cancelled) return;
        if (hasFace) {
          missesRef.current = 0;
          setWarnSecs(null);
        } else {
          missesRef.current += 1;
          const m = missesRef.current;
          if (m >= KICK_AFTER_MISSES) {
            missesRef.current = 0;
            setWarnSecs(null);
            setFacePopup(true);
            onTimeoutRef.current();
          } else if (m >= WARN_AFTER_MISSES) {
            setWarnSecs(Math.ceil(((KICK_AFTER_MISSES - m) * SAMPLE_MS) / 1000));
          }
        }
      }, SAMPLE_MS);
    })();

    return () => {
      cancelled = true;
      // Gate going inactive (disconnect / new stream) → reset for next run.
      missesRef.current = 0;
      setWarnSecs(null);
      if (timer) clearInterval(timer);
      if (video) {
        try {
          video.pause();
        } catch {
          /* noop */
        }
        video.srcObject = null;
      }
      // Detector singleton is shared — never closed here.
    };
  }, [active, stream]);

  return { supported, warnSecs, facePopup, dismissFacePopup };
}
