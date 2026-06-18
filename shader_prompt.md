# ROLE
You are a Senior Graphics Engineer, WebGL Architect, and Three.js Shader Expert, Spark/Dyno Engineer and Graphics Architect.

# CONTEXT
We are building a "Spatial Intelligence" layer for a Gaussian Splat viewer using the SparkJS Dyno DSL. We have a 128x128 binary mask (uMask) from a YOLO service, reconfirm it from the backend code in : C:\Projects\Agents\gemini-test\gemini-test\server.ts. Instead of raw GLSL injection, we need to implement a "Masked Highlight" effect using the Dyno DSL logic block.

# TASK
Provide the plan of replacing the already existing GLSL Shader code with Spark/Dyno's `dyno.dynoBlock` that modifies the splat color and alpha based on the 2D projected position of each splat on our YOLO mask.The "Masked Highlight" to be visible on the click of the object.

# TECHNICAL REQUIREMENTS
1. INPUTS
   - Use `gsplat` (Gsplat input type).
   - Use `uMask` (sampler2D).
   - Use `uCapturedProjectionMatrix` and `uCapturedViewMatrix` (mat4).
   - Use `uMaskActive` (float).

2. LOGIC (Inside the Dyno Block)
   - Coordinate Projection: Calculate the 2D screen UV for the `gsplat.center`. Use the provided matrices to project to NDC, perform perspective divide, and map to [0, 1] range.
   - Texture Sampling: Use the `uMask` sampler to retrieve the mask value at the projected UV.
   - Selection Logic: If the mask value > 0.5 and uMaskActive > 0.5, apply a "Gold Glow" (mix original color with vec3(1.0, 0.8, 0.0) at 0.7 intensity).
   - Alpha Enforcement: If selected, force `gsplat.rgba.a` to 1.0.

3. STRUCTURE
   - Implement the projection logic within the `globals` function as a helper (e.g., `vec2 getMaskUV(vec3 pos, mat4 view, mat4 proj)`).
   - Use the `statements` function to apply the effect to the `outputs.gsplat` based on the mask sampling.

4. DYNOGLSL CONSTRAINTS
   - Use pure, clean GLSL syntax within the `dyno` string blocks.
   - Ensure the perspective divide logic is explicit.
   - Maintain the `gsplat` state: preserve all non-highlighted splats unchanged.

# OUTPUT FORMAT
- Provide the TypeScript code containing the `dyno.dynoBlock`.
- Include the `globals` string containing the GLSL projection math.
- Include the `statements` function applying the Gold Glow effect.
- No conversational filler.

```typescript
const highlightEffect = dyno.dynoBlock(
  { 
    gsplat: dyno.Gsplat, 
    uMask: "sampler2D", 
    uCapturedProjection: "mat4", 
    uCapturedView: "mat4", 
    uMaskActive: "float" 
  },
  { gsplat: dyno.Gsplat },
  ({ gsplat, uMask, uCapturedProjection, uCapturedView, uMaskActive }) => {
    return new dyno.Dyno({
      inTypes: { gsplat, uMask, uCapturedProjection, uCapturedView, uMaskActive },
      outTypes: { gsplat: dyno.Gsplat },
      globals: () => `
        vec2 getMaskUV(vec3 pos, mat4 view, mat4 proj) {
          vec4 ndc = proj * view * vec4(pos, 1.0);
          ndc.xy /= ndc.w; // Perspective divide
          return ndc.xy * 0.5 + 0.5; // Map [-1, 1] to [0, 1]
        }
      `,
      statements: ({ inputs, outputs }) => `
        ${outputs.gsplat} = ${inputs.gsplat};
        
        if (${inputs.uMaskActive} > 0.5) {
          vec2 uv = getMaskUV(${inputs.gsplat}.center, ${inputs.uCapturedView}, ${inputs.uCapturedProjection});
          
          float maskVal = texture2D(${inputs.uMask}, uv).r;
          
          if (maskVal > 0.5) {
            vec3 goldGlow = vec3(1.0, 0.8, 0.0);
            ${outputs.gsplat}.rgba.rgb = mix(${inputs.gsplat}.rgba.rgb, goldGlow, 0.7);
            ${outputs.gsplat}.rgba.a = 1.0; 
          }
        }
      `
    });
  }
);