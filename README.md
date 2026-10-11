# DiceCam — Random P2P Video Chat

<p align="center">
  <img src="Next/public/dicecam-logo.svg" alt="DiceCam" width="120" />
</p>

Omegle-style random video chat for fun. Peer-to-peer video/audio over WebRTC,
text chat over an `RTCDataChannel`, Cloud Firestore as a minimal
signaling & matchmaking backend. Built for sharing with friends — not a
production product.

## Features

- **Random matching** — Start, Next Person (Shuffle), Disconnect/Stop.
- **P2P video + audio** (WebRTC) with local preview once you press Start.
- **Text chat** over a data channel once connected.
- **Camera / mic toggles** on your preview — both off = text-only mode.
- **Face gate** (on-device MediaPipe BlazeFace, nothing leaves the browser):
  warn pill after ~3s with no face, idle + "show your face" popup after ~6s.
  Camera re-enable and fresh camera grants also require a visible face.
- **First-open disclaimer** modal (notice + approve, remembered).
- **Permission handling** — denied / busy / missing-device states each get
  their own dialog with reprompt, plus a reload escape hatch.
- **Resilience** — failed or timed-out connections auto-retry with a fresh
  session (max 2, then an error dialog with manual retry).
- **Signaling hygiene** — atomic room claims, background cleanup on leave,
  sweep-on-start janitor for abandoned rooms, delayed ICE re-sweep.

## Privacy notes (also shown in-app)

- Calls are end-to-end, peer-to-peer. No personal data, footage, or messages
  are stored or processed — Firestore only holds ephemeral signaling docs
  (offers/answers/ICE) that are deleted on leave or swept when stale.
- Your **public IP is visible to the matched stranger** (STUN/WebRTC
  protocol). Use a VPN if you care.
- Face detection runs 100% on-device; no video is sent anywhere for it.

## DiceCam (Next.js)

```bash
cd Next
npm install
npm run dev   # http://localhost:3000
```

Config: copy `Next/env.example` to `Next/.env` and fill from
Firebase Console → Project settings:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_FIREBASE_*` | App keys, project ID, collection (`connections` default) |
| `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` | Optional. Only needed if you enforce App Check |
| `NEXT_PUBLIC_FIREBASE_APPCHECK_DEBUG` | Localhost only (`true` prints a debug token) |

Firebase setup:
1. **Authentication → Sign-in method → enable Anonymous.** (Without it,
   sign-in fails with a 400 from `accounts:signUp` even with a valid key.)
2. **Firestore → Rules tab → paste `Next/firestore.rules` → Publish.**
   Scoped to the rooms collection + per-room ICE collections; anyone may
   delete docs idle past the stale threshold (the janitor depends on this).
3. One-time: wipe any pre-existing `connections` docs and stray
   `*caller`/`*callee` collections (old docs lack `createdAt`, nothing can
   match or reap them).
4. Optional abuse hardening: reCAPTCHA v3 key → App Check → register app →
   watch metrics → **Enforce** on Firestore. Client-side rate limits
   (start/message/room-create) and shape-capped rules already ship.

```bash
npm run build   # type-checked standalone build
npm run lint
```

## Legacy prototype (`Vanilla code/`)

Archived and unused — kept for reference only. The Next.js app above is the
real app. (`Vanilla code/firestore.rules` is superseded by
`Next/firestore.rules`.)

## Notes

- The project began as a JavaScript-only WebRTC learning challenge
  (offer/answer, ICE, data channels, Firestore signaling), then was
  refactored to TypeScript with anonymous Firebase auth and a redesigned UI.
- Fun-project scope: no TURN server (peer IPs visible, by design), no
  server-side moderation, no hard per-user throttling — a modded client can
  bypass the client-side gates. If strangers find the URL and abuse follows,
  enforce App Check and consider moving signaling behind a server.
