The "SplatViewer" Refactoring Directive
Role: Senior Spatial Computing Engineer.
Objective: Fully refactor the provided SplatViewer.ts file into a clean, atomic, and robust production-ready state. Remove all legacy code, commented-out blocks, and fragmented methods.
Architecture Rules:
Single Entry Point (requestAnnotationFromGemini):
Accept box: number[] (bounding box from API) or clickX, clickY (for pinpoint).
Fetch image via this.captureSnapshot() (Ensure renderer.render() + requestAnimationFrame + gl.finish() are called).
API Request: POST to API_BASE_URL with header { "Content-Type": "application/json", "bypass-tunnel-reminder": "true" }.
On response, map data.objects to the pipeline.
Unified Pipeline (executeAnnotationPipeline):
This method acts as the "Brain."
Inputs: box: number[], label: string, description: string.
Steps:
a) Sample a 10x10 grid inside the box using this.getAnnotationPosition (which utilizes the Depth Kernel).
b) Pass the resulting THREE.Vector3[] to this.geometricContext.registerAndMeasureObject(...).
c) If a measurement is returned, trigger renderAnnotation(...).
Single UI Renderer (renderAnnotation):
Delete triggerMuseumCard, createAnnotationElement, and annotateDetectedObject.
Create ONE method: renderAnnotation(worldPos: THREE.Vector3, label: string, description: string, dimensions: THREE.Vector3).
Functionality: Create the DOM container, the pin (dot), and the hidden info card.
CSS: Use z-index: 2500 for cards and pointer-events: none for containers. Use the metadata structure: { name, description, era, material, dimensions }.
Code Quality & Maintenance:
Delete everything commented out. Your final file must contain zero // private... commented blocks.
Use this.geometricContext (the GeometricContextManager class) to store all semantic tokens.
Use THREE.Box3 for the final dimension calculation.
Ensure the code uses async/await throughout; no legacy Promise-chaining.
Validate that metadata.json is loaded via loadMetadata() before processing detections.
Technical Constraints:
The Projection Math: Always use normalizedX * 2 - 1 for NDC coordinates.
Ensure the Depth Kernel samples a 5x5 grid and filters depth >= 0.999.
Memory Safety: In renderAnnotation, dispose of old HTML elements if the user clicks a new object.
Output: Provide the complete, final SplatViewer.ts file. It should be clean, modular, and strictly follow the linear flow: Interaction -> Capture -> Fetch -> Lift/DBSCAN -> Render.