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

const SAMPLE_MS = 1_000;
const WARN_AFTER_MISSES = 3; // ~3s continuous no-face → warn pill
const KICK_AFTER_MISSES = 6; // ~6s continuous no-face → timeout
const SCORE_MIN = 0.6;

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

/**
 * Hidden scratch video for the detector. Attached to the DOM (invisible):
 * mobile browsers throttle or starve fully detached video elements, so no
 * frames ever flow and detection silently never runs.
 */
function makeHiddenVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  video.muted = true;
  video.setAttribute("muted", "");
  video.setAttribute("playsinline", "");
  (video as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;
  video.style.cssText =
    "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
  document.body.appendChild(video);
  return video;
}

function releaseHiddenVideo(video: HTMLVideoElement | null) {
  if (!video) return;
  try {
    video.pause();
  } catch {
    /* noop */
  }
  video.srcObject = null;
  try {
    video.remove();
  } catch {
    /* noop */
  }
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
 * Waits for real frames first (fresh grants need warm-up), then requires
 * 2 of 3 samples positive: a single lucky frame must never open the
 * camera, nor a single blind frame close it.
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
  const video = makeHiddenVideo();
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
    // Up to 6 samples ~500ms apart (~3s window), 2 positives to pass.
    // A face wandering into frame a second or two late must still pass,
    // while a single lucky frame can never open the camera alone.
    let positives = 0;
    let top = 0;
    for (let i = 0; i < 6; i += 1) {
      if (i > 0) await sleep(500);
      try {
        const dets = detector.detectForVideo(video, performance.now())
          .detections;
        const best = dets.reduce(
          (m, d) => Math.max(m, d.categories?.[0]?.score ?? 0),
          0
        );
        top = Math.max(top, best);
        if (dets.length > 0) {
          positives += 1;
          if (positives >= 2) {
            console.info(
              `[face] check: true (${positives}/6 positive, top ${top.toFixed(2)})`
            );
            return true;
          }
        }
      } catch {
        return null;
      }
    }
    console.info(`[face] check: false (${positives}/6 positive, top ${top.toFixed(2)})`);
    return false;
  } catch {
    return null;
  } finally {
    releaseHiddenVideo(video);
  }
}

export function useFaceGate({ stream, active, onTimeout }: FaceGateOpts) {
  const [supported, setSupported] = useState(true);
  const [warnSecs, setWarnSecs] = useState<number | null>(null);
  const [facePopup, setFacePopup] = useState(false);
  const missesRef = useRef(0);
  const warmupRef = useRef(0);
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

      video = makeHiddenVideo();
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        return;
      }
      if (cancelled) return;

      // Fresh activation grace: the first few ticks may run on warming-up
      // frames — never count those as misses (no instant-kick on connect).
      warmupRef.current = 3;

      timer = setInterval(() => {
        if (cancelled || !video) return;
        if (video.readyState < 2 || video.videoWidth === 0) return;
        if (warmupRef.current > 0) {
          warmupRef.current -= 1;
          return;
        }
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
      releaseHiddenVideo(video);
      // Detector singleton is shared — never closed here.
    };
  }, [active, stream]);

  return { supported, warnSecs, facePopup, dismissFacePopup };
}
