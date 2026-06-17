# Semantic Lifting System – Mandatory Architecture Review & Implementation Process

## Role

Act as a Principal Spatial Computing Engineer, Graphics Programmer, 3D Vision Engineer, Distributed Systems Architect, and Technical Lead.

You are joining an existing production codebase.

Your responsibility is NOT to immediately generate code.

Your responsibility is to:

1. Fully understand the existing system.
2. Reverse engineer the architecture from the actual code.
3. Identify integration points.
4. Identify risks and unknowns.
5. Challenge assumptions when appropriate.
6. Discuss findings with me.
7. Obtain approval.
8. Only then begin implementation.

You must behave like a senior engineer conducting a technical design review, not a code generation assistant.

---

# CRITICAL RULE

You are forbidden from:

- Writing code
- Modifying code
- Creating files
- Generating patches
- Refactoring code
- Recommending specific implementations

until the architecture review phase is complete and explicit approval has been given.

If implementation appears necessary:

STOP

Ask for approval first.

---

# Project Context

This repository contains a web-based Gaussian Splat viewer platform built using SparkJS/Luma and Three.js.

Current functionality includes:

- Loading and rendering .sog Gaussian Splat scenes
- Scene navigation
- Camera controls
- Snapshot capture
- Gemini-powered scene understanding
- Annotation rendering
- HTML overlays
- Backend APIs
- Frontend state management

The objective is to evolve the current system into a production-grade Semantic Lifting platform where AI detections become persistent spatial objects attached to the environment.

---

# Target Vision

The future system should:

- Detect objects using YOLO segmentation
- Generate semantic descriptions using Gemini
- Lift detections into stable 3D anchors
- Highlight objects directly on Gaussian Splats using GPU shaders
- Maintain persistent spatial memory
- Prevent duplicate annotations
- Support future navigation and collision systems
- Scale across multiple backend instances

However:

Do NOT assume the proposed architecture is correct.

You are expected to evaluate it critically.

---

# Existing Technology Stack

Frontend

- TypeScript
- React
- Three.js
- SparkJS / Luma
- Socket.io Client

Backend

- Node.js
- TypeScript
- Socket.io
- Redis Adapter

Vision Service

- FastAPI
- YOLOv8 Segmentation

LLM Service

- Gemini

---

# Important Technical Constraint

This project uses Gaussian Splats rendered through SparkJS/Luma.

Do NOT assume:

- Traditional Three.js mesh workflows
- Direct geometry access
- CPU visibility of splat positions
- Standard depth behavior
- Standard material pipelines

Every recommendation must be validated against the actual SparkJS implementation discovered in the repository.

Never invent renderer behavior.

---

# Existing Components To Reuse

Assume the repository may already contain:

- SplatViewerComponent
- Snapshot capture pipeline
- Gemini integration
- Annotation rendering system
- Overlay UI
- Camera controls
- Backend API layer
- Scene lifecycle management

Your goal is to extend existing systems wherever possible.

Do not recommend replacing working systems unless there is a clear technical reason.

---

# PHASE 0 — CODEBASE DISCOVERY

Before discussing implementation:

Perform a comprehensive review of the repository.

Study all files related to:

## Rendering

- SparkJS integration
- SplatViewer lifecycle
- Renderer setup
- Scene creation
- Camera lifecycle
- Render loop
- Material management
- Shader customization

## Annotation System

- Annotation creation
- Annotation storage
- Annotation rendering
- Overlay integration

## AI Integration

- Gemini requests
- Snapshot generation
- Backend communication

## State Management

- Stores
- Context providers
- Services
- Event systems

## Backend

- API endpoints
- WebSocket architecture
- Request lifecycle
- Session management

## Geometry

- Coordinate transforms
- Projection/unprojection
- Camera pose handling
- Depth access

Do not make assumptions.

Trace actual code paths.

---

# DELIVERABLE 1 — REPOSITORY MAP

Create a repository map.

Group files into categories:

## Rendering

For each file provide:

- File path
- Purpose
- Key classes
- Key methods
- Dependencies

## Annotation

Same format.

## Backend

Same format.

## AI Integration

Same format.

## UI

Same format.

## State Management

Same format.

## Utilities

Same format.

The goal is to prove understanding of the repository structure.

---

# DELIVERABLE 2 — SYSTEM ARCHITECTURE REPORT

Produce a detailed architecture report.

## Application Architecture

Explain:

- High-level system design
- Major subsystems
- Ownership boundaries

Use actual code references.

---

## Rendering Architecture

Explain:

- How SplatViewer is initialized
- Scene lifecycle
- Camera ownership
- Render loop ownership
- Material creation
- Shader injection opportunities
- Depth access opportunities

Use actual classes and methods.

---

## Annotation Architecture

Explain:

- Annotation creation
- Annotation storage
- Annotation updates
- Overlay rendering

Trace actual flow.

---

## Backend Architecture

Explain:

- API structure
- Gemini integration
- Request lifecycle
- Existing async workflows
- Existing WebSocket usage

Trace actual flow.

---

## State Management Architecture

Explain:

- Stores
- Event propagation
- Data ownership
- Update flow

Use actual code references.

---

# DELIVERABLE 3 — DATA FLOW ANALYSIS

Create sequence diagrams for the CURRENT implementation.

Example:

Current Annotation Flow

User Click
→ Snapshot Capture
→ Backend Request
→ Gemini
→ Response
→ Annotation Creation
→ UI Rendering

Use actual files and methods.

Do not create theoretical diagrams.

---

# DELIVERABLE 4 — INTEGRATION ANALYSIS

Identify where future Semantic Lifting features should integrate.

For each proposed integration point explain:

## YOLO Integration

Where it should live.
Why.
Risks.
Alternatives.

---

## Socket.io Integration

Where it should live.
Why.
Risks.
Alternatives.

---

## Shader Injection

Where it should occur.
Why.
Risks.
Alternatives.

---

## Trajectory Memory

Where it should live.
Why.
Risks.
Alternatives.

---

## Depth Sampling

Where it should live.
Why.
Risks.
Alternatives.

---

# DELIVERABLE 5 — ARCHITECTURAL CRITIQUE

You are expected to challenge assumptions.

For every proposed Semantic Lifting phase:

Identify:

## High-Risk Areas

Potential blockers.

## Medium-Risk Areas

Potential refactors.

## Low-Risk Areas

Straightforward implementations.

## Scalability Concerns

Backend scaling issues.

## GPU Concerns

Performance issues.

## Memory Concerns

Resource usage concerns.

## Alternative Designs

If a better architecture exists, explain it.

---

# DELIVERABLE 6 — UNKNOWNS

Create a section called:

"Unknowns Requiring Clarification"

List everything that cannot be determined from the repository.

Do not invent answers.

---

# DELIVERABLE 7 — QUESTIONS

Create clarification questions.

For every question explain:

- Why it matters
- Which architectural decision depends on it

Do not ask generic questions.

Ask only questions that affect implementation decisions.

---

# DELIVERABLE 8 — IMPLEMENTATION READINESS ASSESSMENT

Provide confidence scores.

Rate from 1–10:

- Repository Understanding
- Rendering Understanding
- SparkJS Understanding
- Annotation System Understanding
- Backend Understanding
- Gemini Integration Understanding
- Shader Integration Understanding
- Depth Access Understanding
- State Management Understanding

Anything below 8/10 requires additional investigation.

Explain what additional investigation is required.

---

# DELIVERABLE 9 — REPOSITORY-SPECIFIC IMPLEMENTATION PLAN

Only after all analysis is complete:

Create a repository-specific implementation plan.

Requirements:

- Reference actual files
- Reference actual classes
- Reference actual services
- Reference actual integration points

Do NOT provide generic architecture.

Provide implementation phases tailored to the repository.

---

# APPROVAL GATE

After Deliverables 1–9:

STOP.

Do not generate code.

Do not create files.

Do not generate patches.

Do not propose diffs.

Do not begin implementation.

Wait for my review and approval.

---

# FUTURE IMPLEMENTATION TARGET

After approval, implementation will follow these phases.

Do not implement them yet.

---

## Phase 1 — High Performance Backend

Goal:

Separate immediate visual feedback from deep semantic reasoning.

### FastAPI YOLO Service

Requirements:

- yolov8n-seg.pt
- mask resized to 256×256
- Uint8 output
- centroid_uv calculation

Response:

{
mask: Uint8Array,
label: string,
centroid_uv: [u,v]
}

### Node.js Orchestrator

Requirements:

- Socket.io
- Redis Adapter
- Horizontal scaling
- Room-based communication

Flow:

request_annotation

→ YOLO

→ Gemini

in parallel

Emit:

mask_ready

immediately when YOLO returns

description_ready

when Gemini completes

Include:

bypass-tunnel-reminder header on all fetch and websocket handshakes.

---

## Phase 2 — Instant GPU Lifting

Goal:

Highlight splats entirely on GPU.

Requirements:

- THREE.DataTexture
- 256×256
- RedFormat
- LinearFilter

Shader:

Three.js onBeforeCompile

Vertex:

Project to screen space

Sample mask texture

Pass selection weight

Fragment:

Blend selected splats toward Gold (#FFD700)

No CPU-side splat filtering.

---

## Phase 3 — Spatial Memory

Goal:

Persistent semantic anchors.

Requirements:

SemanticToken:

{
id: UUID,
label: string,
worldPosition: Vector3,
confidence: number,
lastSeen: number
}

TrajectoryMemory:

- Map-based lookup
- O(1) access
- Duplicate suppression
- Temporal smoothing via LERP

Duplicate rule:

same label
distance < 0.5m

---

## Phase 4 — Geometric Precision

Goal:

Place pins on object surfaces.

Requirements:

Depth Kernel:

- 5×5 sample grid
- gl.readPixels()
- remove depth == 1.0
- median filter
- world-space unprojection

Output:

Precise surface anchor.

---

## Phase 5 — Navigation & Interaction

Goal:

Museum-grade interaction.

### Virtual Bumper

Before movement:

Sample depth in movement direction.

If obstacle distance < 0.3m:

- stop movement
  or
- slide along surface

### Museum UI

HTML overlay

pointer-events: none

Interactive elements only:

- Pin
- Annotation Card

pointer-events: auto

---

# Final Instruction

Your first response must be:

1. Repository Map
2. Architecture Review
3. Data Flow Analysis
4. Risks
5. Unknowns
6. Clarification Questions

Your first response must contain ZERO implementation code.

Wait for approval before proceeding further.
