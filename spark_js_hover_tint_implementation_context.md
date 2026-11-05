# Implementation Context: Zero-Draw-Call Apartment Hover Tinting in Spark.js

## Objective
Replace explicit translucent polygon box meshes with a zero-draw-call vertex/instance shader modification in **Spark.js**. This technique highlights 3D Gaussian Splats strictly within the 3D extent of a hovered apartment unit on mobile devices.

---

## 1. Problem & Architecture Overview

* **Problem:** Rendering dozens to hundreds of translucent overlay box meshes over Gaussian Splats causes massive transparent overdraw penalties, state changes, and 100–300+ extra draw calls on mobile WebGL/WebGPU contexts.
* **Solution:** 
  1. Pass the inverse transform matrix and half-extents of the hovered apartment box into the Spark.js splat vertex shader.
  2. In the vertex/instance stage (where splat centers are processed), test if each splat's center falls inside the box's local Oriented Bounding Box (OBB) extents.
  3. If inside, apply a color tint directly to the splat in place.
* **Key Benefits:**
  * **0 additional draw calls** for hover highlights.
  * **0 additional geometry/fragment passes** (reuses the existing splat render pass).
  * **0 GPU picker render calls** by shifting hover checks to lightweight CPU Ray-vs-OBB tests.

---

## 2. Technical Specification for Spark.js

### A. Custom Shader Modification (GLSL / WGSL)

Inject the following logic into the Spark.js Gaussian Splat vertex stage before outputting final splat colors:

```glsl
// Uniforms passed to the Spark.js splat material
uniform mat4 uHoverSplatToBoxLocal; // Inverse(BoxWorldMatrix) * SplatWorldMatrix
uniform vec3 uHoverBoxHalfExtents; // Box scale * 0.5
uniform float uHoverActive;         // 1.0 when active, 0.0 when inactive
uniform vec3 uHoverColor;          // e.g., vec3(0.2, 0.9, 0.6)

void modifySplatColor(vec3 splatCenter, inout vec4 splatColor) {
    if (uHoverActive < 0.5) return;

    // 1. Transform splat center into local box space
    vec3 localPos = (uHoverSplatToBoxLocal * vec4(splatCenter, 1.0)).xyz;

    // 2. Check distance along local X, Y, Z axes
    vec3 d = abs(localPos) - uHoverBoxHalfExtents;

    // 3. Test if point is strictly inside OBB
    if (d.x <= 0.0 && d.y <= 0.0 && d.z <= 0.0) {
        // Feather near edges to prevent sharp voxel cuts across facade splats
        float edgeDistance = max(d.x, max(d.y, d.z));
        float mask = smoothstep(0.0, -0.05, edgeDistance);

        // Mix highlight tint into splat RGB
        splatColor.rgb = mix(splatColor.rgb, uHoverColor, 0.45 * mask);
    }
}
```

---

### B. Uniform Management (JavaScript)

Calculate the matrix transform on the CPU whenever a new apartment is hovered:

```javascript
/**
 * Updates shader uniforms when an apartment OBB is hovered.
 * @param {Object} splatMesh - The Spark.js splat mesh object.
 * @param {Object|null} apartmentOBB - The target apartment's OBB bounds data.
 */
function setHoveredApartment(splatMesh, apartmentOBB) {
    const material = splatMesh.material;

    if (!apartmentOBB) {
        material.setUniform('uHoverActive', 0.0);
        return;
    }

    // Matrix: Inverse(BoxWorldMatrix) * SplatWorldMatrix
    const boxInvWorld = apartmentOBB.worldMatrix.clone().invert();
    const splatWorld = splatMesh.worldMatrix;
    const splatToBoxLocal = new Matrix4().multiplyMatrices(boxInvWorld, splatWorld);

    // Update Spark.js material uniforms
    material.setUniform('uHoverSplatToBoxLocal', splatToBoxLocal.elements);
    material.setUniform('uHoverBoxHalfExtents', [
        apartmentOBB.scale.x * 0.5,
        apartmentOBB.scale.y * 0.5,
        apartmentOBB.scale.z * 0.5
    ]);
    material.setUniform('uHoverColor', [0.2, 0.9, 0.6]); // Translucent green/teal accent
    material.setUniform('uHoverActive', 1.0);
}
```

---

### C. CPU-Side Ray vs. OBB Hover Detection

Avoid GPU `pc.Picker` render passes on `pointermove` to protect mobile fill rate:

```javascript
// CPU Ray vs OBB intersection handling
window.addEventListener('pointermove', (event) => {
    const ray = camera.getRayFromScreenCoords(event.clientX, event.clientY);
    
    let hoveredApt = null;
    for (const apt of apartmentList) {
        if (rayIntersectsOBB(ray, apt.obb)) {
            hoveredApt = apt;
            break;
        }
    }

    setHoveredApartment(sparkSplatMesh, hoveredApt);
});
```

---

## 3. Tasks for Claude

Please implement the following based on this context:

1. **Shader Injection:** Provide code to inject or extend the standard Spark.js splat shader with the `modifySplatColor` vertex chunk.
2. **Matrix Helpers:** Create a clean helper class or utility function for matrix multiplication converting world transforms to local box space.
3. **Ray-OBB Intersect Utility:** Write a lightweight CPU ray-vs-Oriented-Bounding-Box (OBB) intersection algorithm.
4. **Complete Usage Example:** Provide a minimal working example initializing Spark.js, loading the splat scene, registering apartment OBBs, and managing hover events.