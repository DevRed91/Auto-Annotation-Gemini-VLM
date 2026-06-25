# Milestone 0 Baseline: Existing Semantic Lifting Pipeline

This document captures the current CPU pipeline exactly as implemented before introducing WebGPU compute.

## 1) Data Flow Diagram

```text
Canvas Click (normalized x,y)
    -> requestAnnotationFromGemini(clickX, clickY, clickWorldPosAtClick)
    -> Backend /annotate returns { label, box:[xmin,ymin,xmax,ymax] }
    -> annotateFromDetection(detection, clickWorldPosAtClick)
    -> sanitizeDetectionBox(box)
    -> samplePointsFromBox(sanitizedBox)
       -> getAnnotationPosition(sampleX, sampleY) [raycast]
       -> getDepthKernel(px, py) [depth readPixels kernel]
       -> depth/raycast fusion -> Vector3[]
    -> geometricContext.registerAndMeasureObject(label, sampledPoints, {eps,minPts})
       -> DBSCAN over [x,y,z]
       -> choose largest cluster
       -> Box3 dimensions + centroid
    -> renderMeasurementBox(clusterPoints)
    -> createAnnotationElement(centroid, label, dimensions)
```

## 2) Sequence Diagram

```text
User
  -> SplatViewer.setupClickInteraction() click handler
  -> SplatViewer.getAnnotationPosition(x,y) for click fallback world point
  -> SplatViewer.requestAnnotationFromGemini(x,y,clickWorldPos)
SplatViewer
  -> captureSnapshot()
  -> fetch(/api/annotate)
Backend
  -> returns detection {label, box}
SplatViewer
  -> annotateFromDetection()
  -> sanitizeDetectionBox()
  -> samplePointsFromBox()
      loop grid samples:
        -> getAnnotationPosition(sampleX,sampleY)
        -> getDepthKernel(px,py)
        -> produce candidate world point if valid
  -> GeometricContextManager.registerAndMeasureObject()
GeometricContextManager
  -> DBSCAN.run(dataset, eps, minPts)
  -> pick largest cluster
  -> Box3.setFromPoints(mainCluster)
  -> return centroid + dimensions + points
SplatViewer
  -> renderMeasurementBox(points)
  -> createAnnotationElement(centroid,label,dimensions)
```

## 3) Function Call Graph (Current)

- `SplatViewer.setupClickInteraction()` in `src/script.ts`
- `SplatViewer.requestAnnotationFromGemini(clickX, clickY, clickWorldPosAtClick)` in `src/script.ts`
- `SplatViewer.annotateFromDetection(detection, clickWorldPosAtClick)` in `src/script.ts`
- `SplatViewer.sanitizeDetectionBox(box)` in `src/script.ts`
- `SplatViewer.samplePointsFromBox(box)` in `src/script.ts`
- `SplatViewer.getAnnotationPosition(normalizedX, normalizedY)` in `src/script.ts`
- `SplatViewer.getDepthKernel(x, y)` in `src/script.ts`
- `GeometricContextManager.registerAndMeasureObject(className, rawPoints, options)` in `src/GeometricContextManager/GeometricContextManager.ts`
- `SplatViewer.renderMeasurementBox(points)` in `src/script.ts`
- `SplatViewer.createAnnotationElement(position, label, dimensions?)` in `src/script.ts`

## 4) Data Structures at Every Stage

### Stage A: Click + Detection Request
- Input:
  - `clickX: number` normalized [0..1]
  - `clickY: number` normalized [0..1]
  - `clickWorldPosAtClick: THREE.Vector3 | null`
- Snapshot:
  - `image: string` (JPEG data URL)

### Stage B: Gemini Detection Response
- `AnnotationDetection`:
  - `label: string`
  - `box: [number, number, number, number]` normalized [xmin,ymin,xmax,ymax]

### Stage C: Box Sanitization
- `sanitizeDetectionBox()` returns:
  - same tuple `[xmin, ymin, xmax, ymax]` clamped to [0,1], or `null`
- Rejection rule:
  - width < 0.02 or height < 0.02 -> discard

### Stage D: 2D->3D Candidate Lift
- Grid:
  - adaptive size in `samplePointsFromBox()` from 6x6 up to 25x25
- Per sample:
  - `worldPosRay: THREE.Vector3 | null` from `getAnnotationPosition()`
  - `depth: number` from `getDepthKernel()` min over 5x5
  - fusion policy:
    - valid depth => unproject NDC -> world point
    - else if raycast valid => use raycast point
    - else drop sample
- Output:
  - `sampledPoints: THREE.Vector3[]`

### Stage E: Clustering + Measurement
- Input:
  - `rawPoints: THREE.Vector3[]`
  - `options: { eps?: number; minPts?: number }`
- DBSCAN working set:
  - `dataset: number[][]` as `[[x,y,z], ...]`
  - `clusters: number[][]` index lists from DBSCAN
- Main cluster selection:
  - largest cluster by point count
- Output object:
  - `label: string`
  - `dimensions: { width:number; height:number; depth:number }`
  - `centroid: THREE.Vector3`
  - `points: THREE.Vector3[]` (main cluster only)
  - `box: THREE.Box3`

### Stage F: Annotation Rendering
- `renderMeasurementBox(points)` creates `THREE.Box3Helper`
- `createAnnotationElement(centroid, label, dimensions)` creates DOM marker/card

## 5) SparkJS Ownership Boundaries (Unchanged Baseline)

SparkJS/Three pipeline currently owns:
- render loop (`renderer.setAnimationLoop`)
- camera + controls updates
- SOG scene integration (`SparkRenderer`, `SplatMesh`)
- scene lifecycle and draw order

Semantic lifting currently runs as CPU-side app logic on top of that pipeline.

## 6) Baseline Bottleneck Notes

- `getDepthKernel()` performs multiple `gl.readPixels` calls per sample (sync-prone).
- `samplePointsFromBox()` runs potentially hundreds of ray/depth queries per click.
- DBSCAN neighborhood work scales poorly as candidate count increases.
- Current path has no GPU-side prefilter/scoring before DBSCAN.
