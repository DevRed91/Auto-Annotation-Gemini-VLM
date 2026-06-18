Migration & Integration Plan

  Step 1: Clean Up Old Shader Hook
  Remove the raw shader injection callback (injectHighlightShader) in src/shader.ts and its direct invocation on
  splatMesh.material in src/script.ts. This decouples the materials from raw Three.js compilation overrides.

  Step 2: Establish Reactive Uniform Inputs
  Using Spark's dynamic uniform types, we register:
   - uMask: A texture binding via dyno.dynoTexture() (updated via standard Three.js texture instances).
   - uCapturedProjection and uCapturedView: Matrix inputs mapped via dyno.dynoMatrix4().
   - uMaskActive: A float controlling state toggle via dyno.dynoFloat().

  Step 3: Implement the dyno.dynoBlock
  Replace the vertex-to-fragment pipeline with a single unified Dyno modifier block on the splatMesh.objectModifier
  hook. This lets the GPU process the projection on each individual splat centroid dynamically, feeding directly
  into the SparkJS generator.

  ---

  TypeScript & Dyno Implementation Code

```typescript
import { dyno } from "@sparkjsdev/spark";
import * as THREE from "three";

// 1. Declare local Dyno variables for active state tracking
export const dynoMask = dyno.dynoTexture(null as THREE.Texture | null);
export const dynoMaskActive = dyno.dynoFloat(0.0);
export const dynoCapturedProjection = dyno.dynoMatrix4(new THREE.Matrix4());
export const dynoCapturedView = dyno.dynoMatrix4(new THREE.Matrix4());

/**
 * Spark/Dyno Block modifying the splat color and alpha dynamically
 * based on the 2D projected coordinate of each splat.
 */
export const highlightEffect = dyno.dynoBlock(
  {
    gsplat: dyno.Gsplat,
    uMask: "sampler2D",
    uCapturedProjection: "mat4",
    uCapturedView: "mat4",
    uMaskActive: "float",
  },
  { gsplat: dyno.Gsplat },
  ({ gsplat, uMask, uCapturedProjection, uCapturedView, uMaskActive }) => {
    return new dyno.Dyno({
      inTypes: { gsplat, uMask, uCapturedProjection, uCapturedView, uMaskActive },
      outTypes: { gsplat: dyno.Gsplat },
      
      // 2. GLSL Helper function defined in globals
      globals: () => `
        vec2 getMaskUV(vec3 pos, mat4 view, mat4 proj) {
          vec4 projected = proj * view * vec4(pos, 1.0);
          
          // Verify splat is not behind the snapshot camera near plane (w > 0)
          if (projected.w <= 0.001) {
            return vec2(-1.0); // Map out of bounds to bypass sampling
          }
          
          vec2 ndc = projected.xy / projected.w; // Perspective divide
          vec2 uv = ndc * 0.5 + 0.5;             // Map range [-1, 1] to [0, 1]
          uv.y = 1.0 - uv.y;                     // Correct for WebGL top-left Y flip
          return uv;
        }
      `,
      
      // 3. Execution statements applying the Glow and Alpha adjustments
      statements: ({ inputs, outputs }) => `
        ${outputs.gsplat} = ${inputs.gsplat};
        
        if (${inputs.uMaskActive} > 0.5) {
          vec2 uv = getMaskUV(${inputs.gsplat}.center, ${inputs.uCapturedView},
      ${inputs.uCapturedProjection});
          
          // Guard against out-of-bounds texture bleeding
          if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
            float maskVal = texture2D(${inputs.uMask}, uv).r;
            
            if (maskVal > 0.5) {
              vec3 goldGlow = vec3(1.0, 0.8, 0.0);
              // Mix original splat color with Gold Glow at 70% intensity
              ${outputs.gsplat}.rgba.rgb = mix(${inputs.gsplat}.rgba.rgb, goldGlow, 0.7);
              // Force alpha to 1.0 to eliminate transparency/ghosting artifacts
              ${outputs.gsplat}.rgba.a = 1.0;
            }
          }
        }
      `,
    });
  }
);

/**
 * Activates the modifier on the splat mesh and updates the generator pipeline.
 */
export function injectHighlightDyno(splatMesh: any): void {
  splatMesh.objectModifier = highlightEffect;
  splatMesh.updateGenerator();
}

/**
 * Updates dynamic Dyno uniforms when a new mask snapshot is generated.
 */
export function updateHighlightDynoUniforms(
  capturedProjection: THREE.Matrix4,
  capturedView: THREE.Matrix4,
  maskTexture: THREE.Texture,
  active: boolean
): void {
  dynoCapturedProjection.value.copy(capturedProjection);
  dynoCapturedView.value.copy(capturedView);
  dynoMask.value = maskTexture;
  dynoMaskActive.value = active ? 1.0 : 0.0;
}
```