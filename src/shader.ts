import { dyno } from "@sparkjsdev/spark";
import * as THREE from "three";

// 1. Declare module-level reactive Dyno variables for active state tracking.
//    These are reactive "uniforms" that can be updated at any time and will
//    automatically propagate to the GPU without needing to recompile the shader.
// Create a safe 1×1 RGBA placeholder so the sampler uniform is always bound
// to a valid GPU texture object before a real mask arrives. An uninitialized
// THREE.Texture() has no image data and will fail validation on strict drivers.
const _placeholderMaskTexture = new THREE.DataTexture(
  new Uint8Array([0, 0, 0, 0]),
  1,
  1,
  THREE.RGBAFormat
);
_placeholderMaskTexture.needsUpdate = true;
export const dynoMask = dyno.dynoSampler2D(_placeholderMaskTexture);
export const dynoMaskActive = dyno.dynoFloat(0.0);
export const dynoCapturedProjection = dyno.dynoMat4(new THREE.Matrix4());
export const dynoCapturedView = dyno.dynoMat4(new THREE.Matrix4());

/**
 * Spark/Dyno Block modifying the splat color and alpha dynamically
 * based on the 2D projected coordinate of each splat.
 *
 * This replaces the old raw onBeforeCompile vertex/fragment injection.
 * The block receives each splat's center in world-space, projects it using
 * the frozen snapshot camera matrices, and samples the binary mask texture
 * to apply a gold glow highlight to selected splats.
 */
export const highlightEffect = dyno.dynoBlock(
  { gsplat: dyno.Gsplat },
  { gsplat: dyno.Gsplat },
  ({ gsplat }) => {
    const highlightDyno = new dyno.Dyno({
      inTypes: {
        gsplat: dyno.Gsplat,
        uMask: "sampler2D",
        uCapturedProjection: "mat4",
        uCapturedView: "mat4",
        uMaskActive: "float",
      },
      outTypes: { gsplat: dyno.Gsplat },

      // 2. GLSL Helper function defined in globals (compiled once, shared across all splats)
      globals: () => [dyno.unindent(`
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
      `)],

      // 3. Execution statements: apply the Gold Glow and Alpha adjustments per splat
      statements: ({ inputs, outputs }) => dyno.unindentLines(`
        ${outputs.gsplat} = ${inputs.gsplat};

        if (${inputs.uMaskActive} > 0.5) {
          vec2 uv = getMaskUV(
            ${inputs.gsplat}.center,
            ${inputs.uCapturedView},
            ${inputs.uCapturedProjection}
          );

          // Guard against out-of-bounds texture bleeding
          if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
            // Use texture() — GLSL ES 3.00 (WebGL2) removed texture2D().
            // Using the deprecated form is the direct cause of shader compile failure.
            float maskVal = texture(${inputs.uMask}, uv).r;

            if (maskVal > 0.5) {
              vec3 goldGlow = vec3(1.0, 0.8, 0.0);
              // Mix original splat color with Gold Glow at 70% intensity
              ${outputs.gsplat}.rgba.rgb = mix(${inputs.gsplat}.rgba.rgb, goldGlow, 0.7);
              // Force alpha to 1.0 to eliminate transparency/ghosting artifacts
              ${outputs.gsplat}.rgba.a = 1.0;
            }
          }
        }
      `),
    });

    const outputs = highlightDyno.apply({
      gsplat,
      uMask: dynoMask,
      uCapturedProjection: dynoCapturedProjection,
      uCapturedView: dynoCapturedView,
      uMaskActive: dynoMaskActive,
    });

    return { gsplat: outputs.gsplat };
  }
);

/**
 * Activates the Dyno highlight modifier on a SplatMesh and rebuilds the
 * generator pipeline. Call this once after the SplatMesh is created,
 * replacing the old injectHighlightShader(splatMesh) call.
 */
export function injectHighlightDyno(splatMesh: any): void {
  splatMesh.objectModifier = highlightEffect;
  splatMesh.updateGenerator();
}

/**
 * Updates all reactive Dyno uniforms when a new mask snapshot is generated.
 * Because the Dyno variables are reactive, changes here are automatically
 * reflected on the GPU in the next render frame.
 *
 * @param capturedProjection - Projection matrix cloned at snapshot moment
 * @param capturedView - View matrix (matrixWorldInverse) cloned at snapshot moment
 * @param maskTexture - The binary mask texture (e.g. 128x128 DataTexture)
 * @param active - Whether the highlight effect is currently active
 */
export function updateHighlightDynoUniforms(
  capturedProjection: THREE.Matrix4,
  capturedView: THREE.Matrix4,
  maskTexture: THREE.Texture,
  active: boolean
): void {
  const image = (maskTexture as THREE.DataTexture).image as
    | { data?: ArrayLike<number>; width?: number; height?: number }
    | undefined;
  const isTextureUsable =
    !!image &&
    typeof image.width === "number" &&
    typeof image.height === "number" &&
    image.width > 0 &&
    image.height > 0 &&
    !!image.data;

  if (!active || !isTextureUsable) {
    dynoMaskActive.value = 0.0;
    return;
  }

  // Only activate after all three dependencies are confirmed valid.
  // Updating the texture uniform before setting active=0 would leave the
  // sampler pointing at a disposed texture on the next frame.
  dynoCapturedProjection.value.copy(capturedProjection);
  dynoCapturedView.value.copy(capturedView);
  dynoMask.value = maskTexture;
  // Activate last so the GPU sees a consistent uniform state in the same frame.
  dynoMaskActive.value = 1.0;
}
