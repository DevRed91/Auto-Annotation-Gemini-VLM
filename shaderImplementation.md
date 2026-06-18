import * as THREE from "three";
     2
     3 // File-level active uniforms reference for dynamic updating
     4 let activeUniforms: {
     5   uMask: { value: THREE.Texture | null };
     6   uMaskActive: { value: number };
     7   uCapturedProjectionMatrix: { value: THREE.Matrix4 };
     8   uCapturedViewMatrix: { value: THREE.Matrix4 };
     9 } | null = null;
    10
    11 /**
    12  * Injects custom shader logic into the SplatMesh material using onBeforeCompile.
    13  * Maps a 2D binary mask to the 3D scene by projecting splat coordinates 
    14  * onto a captured camera perspective dynamically inside the GPU.
    15  * 
    16  * @param splatMesh - The SplatMesh instance to inject
    17  */
    18 export function injectHighlightShader(splatMesh: any): void {
    19   const material = splatMesh?.material || splatMesh?.mesh?.material;
    20   if (!material) {
    21     console.warn("Could not find material on SplatMesh to inject custom shader.");
    22     return;
    23   }
    24
    25   // Define uniform set for the instant glow projection
    26   const uniforms = {
    27     uMask: { value: null as THREE.Texture | null },
    28     uMaskActive: { value: 0.0 },
    29     uCapturedProjectionMatrix: { value: new THREE.Matrix4() },
    30     uCapturedViewMatrix: { value: new THREE.Matrix4() },
    31   };
    32
    33   activeUniforms = uniforms;
    34
    35   // Intercept compilation to inject custom uniforms, varyings, and projection logic
    36   material.onBeforeCompile = (shader: THREE.Shader) => {
    37     // Append the custom uniforms to the existing material uniforms dictionary
    38     Object.assign(shader.uniforms, uniforms);
    39
    40     // 1. Inject Uniforms & Varyings into Vertex Shader
    41     shader.vertexShader = shader.vertexShader.replace(
    42       "void main() {",
    43       `uniform sampler2D uMask;
    44 uniform float uMaskActive;
    45 uniform mat4 uCapturedProjectionMatrix;
    46 uniform mat4 uCapturedViewMatrix;
    47 varying float vIsSelected;
    48
    49 void main() {`
    50     );
    51
    52     // 2. Vertex Shader Transformation & Sampling Logic (inserted before main closing brace)
    53     shader.vertexShader = shader.vertexShader.replace(
    54       /}\s*$/,
    55       `
    56   // --- Geometric Anchoring via Captured Camera Projection ---
    57   // To prevent "projector beam drift" (the sliding of the 2D projected mask over 3D splats
    58   // when the rendering camera moves), we must project the 3D splat world coordinate using 
    59   // the static snapshot camera matrices (uCapturedViewMatrix and uCapturedProjectionMatrix).
    60   // This freeze-frames the projection frustum at the exact moment of the snapshot, 
    61   // anchoring the 2D texture coordinates permanently to their respective 3D vertices.
    62   vec4 capturedProjPos = uCapturedProjectionMatrix * uCapturedViewMatrix * modelMatrix * vec4(position, 1.0);
    63   
    64   // Explicit perspective divide to obtain Normalized Device Coordinates (NDC) in range [-1, 1]
    65   vec2 ndc = capturedProjPos.xy / capturedProjPos.w;
    66   
    67   // Transform NDC range [-1, 1] to UV texture coordinates range [0, 1]
    68   vec2 maskUV = ndc * 0.5 + 0.5;
    69   
    70   // Correct for WebGL texture coordinate system (bottom-left) vs. screen-space (top-left)
    71   maskUV.y = 1.0 - maskUV.y;
    72   
    73   // Verify NDC coordinates are within bounds [0, 1] to avoid out-of-bounds coordinate bleeding
    74   float inBounds = step(-1.0, ndc.x) * step(ndc.x, 1.0) * step(-1.0, ndc.y) * step(ndc.y, 1.0);
    75   
    76   // Sample mask texture. Step function guarantees that points behind the snapshot camera (w <= 0)
    77   // are discarded gracefully without dynamic branching.
    78   vIsSelected = texture2D(uMask, maskUV).r * step(0.001, capturedProjPos.w) * inBounds;
    79 }`
    80     );
    81
    82     // 3. Inject Uniforms & Varyings into Fragment Shader
    83     shader.fragmentShader = shader.fragmentShader.replace(
    84       "void main() {",
    85       `uniform sampler2D uMask;
    86 uniform float uMaskActive;
    87 varying float vIsSelected;
    88
    89 void main() {`
    90     );
    91
    92     // 4. Fragment Shader Glow Blending & Alpha Guard Logic (inserted before main closing brace)
    93     shader.fragmentShader = shader.fragmentShader.replace(
    94       /}\s*$/,
    95       `
    96   // --- Dynamic Branchless Highlight Blending ---
    97   // Combine selection varyings to calculate the activation scalar.
    98   // Using step functions avoids expensive GPU execution branching.
    99   float selectFactor = step(0.5, vIsSelected) * step(0.5, uMaskActive);
   100   
   101   // Blend computed output color with Gold Glow (RGB: 1.0, 0.8, 0.0) at 70% mixing intensity
   102   gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0, 0.8, 0.0), 0.7 * selectFactor);
   103   
   104   // Alpha Guard: Clamp fragment alpha to 1.0 if selected to prevent "ghosting" artifacts 
   105   // and reveal issues when looking through transparent splats.
   106   gl_FragColor.a = mix(gl_FragColor.a, 1.0, selectFactor);
   107 }`
   108     );
   109   };
   110 }
   111
   112 /**
   113  * Updates shader uniforms dynamically when a new mask snapshot is generated.
   114  * 
   115  * @param capturedProjection - Projection matrix cloned at snapshot moment
   116  * @param capturedView - View matrix (matrixWorldInverse) cloned at snapshot moment
   117  * @param maskTexture - The 128x128 binary mask texture
   118  * @param active - Active state flag (0.0 = disabled, 1.0 = enabled)
   119  */
   120 export function updateShaderUniforms(
   121   capturedProjection: THREE.Matrix4,
   122   capturedView: THREE.Matrix4,
   123   maskTexture: THREE.Texture,
   124   active: boolean
   125 ): void {
   126   if (activeUniforms) {
   127     activeUniforms.uCapturedProjectionMatrix.value.copy(capturedProjection);
   128     activeUniforms.uCapturedViewMatrix.value.copy(capturedView);
   129     activeUniforms.uMask.value = maskTexture;
   130     activeUniforms.uMaskActive.value = active ? 1.0 : 0.0;
   131   }
   132 }