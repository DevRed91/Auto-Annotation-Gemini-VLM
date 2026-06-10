# Semantic Lifting System Design Review (Discussion First, No Implementation Yet)

You are acting as a Senior Spatial Computing Engineer, Computer Vision Engineer, Graphics Engineer, and SparkJS Expert.

## IMPORTANT

Do NOT implement any code yet.

Do NOT generate TypeScript, shaders, workers, classes, utilities, or file changes.

Your first responsibility is to understand the existing system and identify unknowns before implementation.

Treat this as a technical design review.

---

# Expected Workflow

## Phase 1 — Repository Discovery

First inspect the codebase and identify:

### Rendering Layer

- How SparkJS loads `.sog` files
- How splat positions are stored
- Whether splat positions are CPU accessible
- Whether splat positions exist in:

  - TypedArrays
  - GPU buffers only
  - Custom Spark structures

### Camera Layer

Determine:

- How camera matrices are obtained
- Whether Three.js camera instances are used directly
- How viewport dimensions are managed

### Rendering Pipeline

Determine:

- How render passes are configured
- Whether depth buffers are accessible
- Whether color buffer capture already exists
- Whether offscreen rendering already exists

### Shader Layer

Determine:

- Where splat shaders are defined
- Whether custom attributes can be added
- Whether per-splat selection attributes already exist
- Whether highlight logic already exists

### Scene Graph

Determine:

- Whether splats are represented as a single renderable
- Whether splat indices are stable
- Whether index ordering changes during LoD

---

## Phase 2 — Architecture Assessment

After repository inspection:

Provide a written assessment.

Include:

### What already exists

### What is missing

### Technical risks

### Performance bottlenecks

### Mathematical concerns

### GPU vs CPU ownership concerns

### SparkJS limitations

### Areas requiring validation

---

## Phase 3 — Clarification Questions

Before proposing implementation, ask all required questions.

Examples:

### Splat Data Access

- Can we access all splat positions on CPU?
- How many splats are typical?
- Are positions stable across LoD transitions?

### Selection

- Do we need permanent semantic selections?
- Can a splat belong to multiple labels?

### Visualization

- Single active label?
- Multiple simultaneous labels?
- Color-per-label?

### Storage

- Runtime only?
- Persist to backend?
- Persist inside scene metadata?

### Accuracy

- Bounding boxes only?
- SAM masks planned immediately?
- Depth verification required in V1?

### Performance

- Maximum scene size?
- Target FPS?
- Worker budget?

### UX

- Automatic Gemini invocation?
- User-triggered semantic detection?
- Detection per frame or per viewpoint?

Ask every question necessary before implementation.

Do not assume answers.

---

## Phase 4 — Proposed Design

Only after questions are answered:

Provide:

### System Architecture

### Data Flow

### Worker Architecture

### Annotation Data Model

### GPU Highlight Strategy

### API Contracts

### Persistence Format

### Future SAM Integration

### Performance Analysis

### Risk Analysis

---

## Phase 5 — Wait For Approval

After presenting the design:

Stop.

Do not implement.

Wait for approval.

Only after explicit approval should implementation begin.

---

# Desired Output

Return:

1. Repository findings
2. Technical observations
3. Risks
4. Clarification questions
5. Proposed architecture

No code.

No implementation.

No file modifications.

No pseudocode.

This phase is strictly for design review and requirements validation.
