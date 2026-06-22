# Refactor Plan Request: SplatViewer.ts Semantic Lifting Pipeline

## Role

You are a Senior Frontend Engineer specializing in:

* Three.js
* SparkJS / Gaussian Splat rendering
* Spatial Computing
* TypeScript
* Computer Vision pipelines
* Production-grade frontend architecture

---

## IMPORTANT: REVIEW FIRST, DO NOT IMPLEMENT IMMEDIATELY

Before making any code changes:

1. Read the entire `SplatViewer.ts` implementation.

2. Trace the complete annotation flow from:

   * User click
   * Screenshot capture
   * Gemini API request
   * Detection processing
   * Point cloud lifting
   * Measurement
   * Annotation rendering

3. Produce a detailed analysis containing:

### Existing Flow Analysis

Identify:

* Current click handling flow
* Current API request flow
* Current annotation rendering flow
* Current measurement flow
* Current DOM overlay creation flow

### Redundant / Legacy Code

List all:

* Dead code
* Unused methods
* Duplicate logic
* Commented-out implementations
* Legacy annotation paths
* Obsolete rendering methods

### Refactor Impact Assessment

Explain:

* Which methods should be deleted
* Which methods should be merged
* Which methods should become the new source of truth
* Any risks or hidden dependencies

---

## WAIT FOR APPROVAL

Do not modify code after the analysis.

Provide:

1. Understanding of existing architecture
2. Proposed refactor plan
3. List of methods to delete
4. List of methods to modify
5. List of methods to keep

Then stop and wait for approval.

---

# Refactor Objective

After approval, refactor `SplatViewer.ts` into a single, unified Semantic Lifting pipeline.

The final flow must be:

User Click
→ Gemini Request
→ Depth-Kernel Lift
→ DBSCAN Registration
→ Measurement
→ Annotation Rendering

No parallel flows.
No legacy code paths.
No duplicate rendering systems.

---

# Architecture Requirements

## Unified Rendering System

Delete:

* `triggerMuseumCard`
* `createAnnotationElement`
* `annotateDetectedObject`
* `processDetection`

Replace with:

```ts
private renderAnnotation(
  worldPos: THREE.Vector3,
  label: string,
  description: string,
  dimensions: THREE.Vector3
): void
```

### renderAnnotation Responsibilities

Must create:

* Annotation container
* Pin marker
* Expanded information card

### Styling Requirements

Container:

```css
pointer-events: none;
```

Card:

```css
z-index: 2500;
```

### Metadata Structure

Use:

```ts
{
  name: string;
  description: string;
  era: string;
  material: string;
  dimensions: string;
}
```

---

## Unified API Entry Point

`requestAnnotationFromGemini(box: number[])`

must become the ONLY entry point for Gemini annotation results.

Expected API response:

```json
{
  "objects": [
    {
      "label": "...",
      "description": "...",
      "box": [x1, y1, x2, y2]
    }
  ]
}
```

Processing loop:

```ts
for (const object of response.objects) {
  await executeAnnotationPipeline(
    object.box,
    object.label,
    object.description
  );
}
```

No alternate processing paths.

---

## Unified Processing Method

Implement:

```ts
private async executeAnnotationPipeline(
  box: number[],
  label: string,
  description: string
): Promise<void>
```

### Responsibilities

#### Step 1 — Depth-Kernel Lift

Use existing:

```ts
getAnnotationPosition(...)
```

to obtain 3D coordinates.

#### Step 2 — DBSCAN Registration

Use:

```ts
this.geometricContext.registerAndMeasureObject(...)
```

for semantic registration.

#### Step 3 — Measurement

Use:

```ts
THREE.Box3
```

for measurement extraction.

#### Step 4 — Render

If measurement succeeds:

```ts
renderAnnotation(...)
```

Otherwise:

* Log failure
* Do not render

---

# Cleanup Requirements

Remove all commented-out code including:

* Legacy `setupAnnotationUI`
* Old `requestAnnotation...` implementations
* Deprecated annotation workflows
* Experimental rendering branches
* Dead helper functions

The final file should contain only active production code.

---

# Initialization Requirements

Verify and clean initialization for:

```ts
this.annotations
```

and

```ts
this.metadataDB
```

Ensure:

* No duplicate initialization
* No stale references
* No unused collections

---

# Network Requirements

Gemini request must include:

```ts
headers["bypass-tunnel-reminder"] = "true";
```

when tunnel bypass is enabled.

---

# Success Criteria

The final architecture must have:

Single Click Handler
→ Single API Entry Point
→ Single Annotation Pipeline
→ Single Render System

There must be:

* No duplicate annotation logic
* No parallel rendering systems
* No legacy methods
* No commented-out debris
* No dead code

---

# Deliverables

Phase 1:

* Existing code analysis
* Architecture understanding
* Refactor plan
* Questions / risks

STOP and wait for approval.

Phase 2 (after approval):

* Complete refactored `SplatViewer.ts`
* Full file output
* No placeholders
* No pseudocode
* No omitted sections
* Production-ready TypeScript
