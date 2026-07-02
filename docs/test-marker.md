# Native camera validation roadmap

This document starts the production hardening layer for Bio Beat Tracker.

## Goal

Android should move from best-effort WebView camera behavior toward a native camera layer that reports stable per-device capability and runtime telemetry. The current WebRTC path remains the fallback while native capture is introduced safely.

## Phase 1: native camera capability report

- Enumerate back cameras.
- Report torch availability.
- Report FPS ranges.
- Report ISO and exposure-time ranges when exposed by the device.
- Report sensor orientation and hardware level.
- Return a preferred back-camera id for PPG.

## Phase 2: device profiles

Persist a profile per phone and camera containing device model, provider, camera id, torch state, FPS, jitter, frame-drop estimate, resolution, ROI, exposure limits and notes.

## Phase 3: validation harness

Add replay-style reports for recorded sessions: HR error, valid-reading coverage, time to first reading, SpO2 error when reference is present, BP error when reference is present and arrhythmia window checks when RR labels are present.

## Engineering rule

Recorded sessions and fixtures are only for testing. Runtime measurements continue to come from live camera frames and signal-quality metrics.
