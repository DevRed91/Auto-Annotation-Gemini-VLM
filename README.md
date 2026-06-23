# Gaussian Splat Frontend

This project is a Vite-based frontend for viewing and annotating Gaussian splat scenes in the browser. It renders the scene with Three.js and Spark, supports mobile controls, and includes an annotation flow that can lift 2D detections into 3D world-space measurements.

## What the app does

The frontend currently provides:

1. Scene loading from a local splat asset or a generated world URL.
2. Click-based annotation mode for selecting objects in the viewport.
3. Snapshot-based annotation requests to a companion `/api/annotate` endpoint.
4. 2D-to-3D lifting using raycasts into the active splat scene.
5. Measurement clustering with DBSCAN before dimensions are shown in the UI.

## Tech Stack

- Vite
- TypeScript
- Three.js
- `@sparkjsdev/spark`
- `density-clustering`

## Prerequisites

- Node.js 18 or newer
- npm

## Installation

```bash
npm install
```

## Development

```bash
npm run dev
```

Open the Vite dev server URL in your browser after startup.

## Build

```bash
npm run build
```

## Preview Production Build

```bash
npm run preview
```

## Runtime Flow

The current frontend flow is:

1. `src/main.ts` renders the landing UI and wires the optional World Labs generation controls.
2. `src/script.ts` creates the Three.js scene, camera, renderer, and splat viewer.
3. `loadWorld(...)` loads a splat into the scene.
4. Annotation mode captures click coordinates and snapshots.
5. The app sends the snapshot and click position to `/api/annotate`.
6. Returned detections are sampled across the Gemini box.
7. Sampled points are raycast into world space.
8. `GeometricContextManager.registerAndMeasureObject(...)` clusters the points with DBSCAN.
9. The largest cluster is used to build a `THREE.Box3` measurement and display dimensions in the UI.

## Environment Variables

Create a `.env` file in the project root.

```text
VITE_API_BASE_URL=/api
VITE_BYPASS_TUNNEL_REMINDER=false
```

### `VITE_API_BASE_URL`

Base URL for the annotation service.

- Use `/api` for local development with a proxy.
- Use a full tunnel or backend URL when the annotation service is hosted elsewhere.

### `VITE_BYPASS_TUNNEL_REMINDER`

Set to `true` only if your tunnel provider requires the custom `bypass-tunnel-reminder` header.

## World Labs Integration

`src/worldlabs.ts` can generate a splat from a user-provided image URL.

The current UI path expects:

- a World Labs API key
- an image URL
- a returned splat/world URL that `loadWorld(...)` can open

If you do not use World Labs generation, you can still run the viewer with the bundled assets in `public/`.

## Annotation Pipeline

The current annotation path is implemented in `src/script.ts`:

1. Toggle the annotation tool in the toolbar.
2. Click on the scene.
3. Capture the click position and a snapshot.
4. Send the snapshot plus click coordinates to the annotation endpoint.
5. Sample points inside the returned 2D box.
6. Lift valid samples into 3D.
7. Cluster the lifted points with DBSCAN.
8. Measure the dominant cluster with `THREE.Box3`.

This means the displayed dimensions are derived from the surviving 3D sample cluster, not directly from the original 2D box.

## Project Structure

- `src/main.ts` - app bootstrap and landing UI
- `src/script.ts` - scene setup, annotation flow, and measurement rendering
- `src/GeometricContextManager/GeometricContextManager.ts` - clustering and measurement logic
- `src/worldlabs.ts` - optional world generation client
- `src/style.css` - UI styling
- `public/` - bundled scene assets

## Notes

- The repo currently contains the frontend implementation only.
- The annotation endpoint is expected to exist separately at `/api/annotate` or at the URL configured in `VITE_API_BASE_URL`.
- The codebase is currently optimized around browser-side rendering and measurement, not a server-rendered flow.
