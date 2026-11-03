import * as THREE from "three";

export interface DottedLineOptions {
  spacing?: number;
  dotRadius?: number;
  minPixelRadius?: number;
  maxDots?: number;
  colorStart?: THREE.ColorRepresentation;
  colorEnd?: THREE.ColorRepresentation;
  coreColor?: THREE.ColorRepresentation;
  flowSpeed?: number;
  glowStrength?: number;
  falloff?: number;
  opacity?: number;
}

const DEFAULTS: Required<DottedLineOptions> = {
  spacing: 0.25,
  dotRadius: 0.05,
  minPixelRadius: 2.5,
  maxDots: 2048,
  colorStart: 0x1e50ff,
  colorEnd: 0x3fe0ff,
  coreColor: 0xeaf6ff,
  flowSpeed: 0.4,
  glowStrength: 0.6,
  falloff: 4.5,
  opacity: 1.0,
};

const vertexShader = /* glsl */ `
  attribute float aT;

  uniform vec2 uResolution;
  uniform float uDotRadius;
  uniform float uMinPixelRadius;

  varying vec2 vUv;
  varying float vT;

  void main() {
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float pxRadius = uDotRadius * projectionMatrix[1][1] * 0.5 * uResolution.y;
    // Perspective projections have a zero bottom-right matrix element. In
    // orthographic projections the projected size is independent of depth.
    if (projectionMatrix[3][3] == 0.0) {
      pxRadius /= max(-mv.z, 0.0001);
    }
    float r = uDotRadius * max(1.0, uMinPixelRadius / max(pxRadius, 0.0001));
    mv.xy += position.xy * r;
    gl_Position = projectionMatrix * mv;
    vUv = position.xy;
    vT = aT;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColorStart;
  uniform vec3 uColorEnd;
  uniform vec3 uCoreColor;
  uniform float uCoreWidth;
  uniform float uFalloff;
  uniform float uGlowStrength;
  uniform float uOpacity;

  varying vec2 vUv;
  varying float vT;

  void main() {
    float r = length(vUv);
    if (r > 1.0) discard;
    float core = smoothstep(uCoreWidth, 0.0, r);
    float halo = exp(-uFalloff * r * r);
    vec3 base = mix(uColorStart, uColorEnd, clamp(vT, 0.0, 1.0));
    vec3 color = mix(base, uCoreColor, core);
    float edgeFade = smoothstep(1.0, 0.82, r);
    gl_FragColor = vec4(color, (core + halo * uGlowStrength) * uOpacity * edgeFade);
  }
`;

/** A world-spaced, camera-facing dotted polyline with an animated flow. */
export class DottedLine {
  readonly object: THREE.InstancedMesh;

  private readonly pathGeometry = new THREE.BufferGeometry();
  private readonly dotGeometry: THREE.PlaneGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly aT: THREE.InstancedBufferAttribute;
  private readonly matrixArray: Float32Array;
  private readonly cachedPosition = new THREE.Vector3();
  private readonly segmentStart = new THREE.Vector3();
  private readonly segmentEnd = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly options: Required<DottedLineOptions>;
  private cachedPoints: readonly THREE.Vector3[] | null = null;
  private totalLength = 0;
  private flowOffset = 0;
  private lastFlowOffset = -1;

  constructor(options: DottedLineOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.dotGeometry = new THREE.PlaneGeometry(2, 2);
    this.aT = new THREE.InstancedBufferAttribute(
      new Float32Array(this.options.maxDots),
      1,
    );
    this.aT.setUsage(THREE.DynamicDrawUsage);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        uDotRadius: { value: this.options.dotRadius },
        uMinPixelRadius: { value: this.options.minPixelRadius },
        uColorStart: { value: new THREE.Color(this.options.colorStart) },
        uColorEnd: { value: new THREE.Color(this.options.colorEnd) },
        uCoreColor: { value: new THREE.Color(this.options.coreColor) },
        uCoreWidth: { value: 0.12 },
        uFalloff: { value: this.options.falloff },
        uGlowStrength: { value: this.options.glowStrength },
        uOpacity: { value: this.options.opacity },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this.object = new THREE.InstancedMesh(
      this.dotGeometry,
      this.material,
      this.options.maxDots,
    );
    this.object.geometry.setAttribute("aT", this.aT);
    this.object.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.matrixArray = this.object.instanceMatrix.array as Float32Array;
    this.object.count = 0;
    this.object.renderOrder = 999;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  setEndpoints(start: THREE.Vector3, end: THREE.Vector3): void {
    this.setPoints([start, end]);
  }

  setPoints(points: readonly THREE.Vector3[]): void {
    if (points.length < 2) {
      this.cachedPoints = null;
      this.object.count = 0;
      this.object.visible = false;
      return;
    }

    this.pathGeometry.setFromPoints(points as THREE.Vector3[]);
    this.cachedPoints = points;
    this.totalLength = 0;
    const positions = this.pathGeometry.attributes.position;
    for (let i = 1; i < positions.count; i += 1) {
      this.totalLength += Math.sqrt(
        (positions.getX(i) - positions.getX(i - 1)) ** 2 +
          (positions.getY(i) - positions.getY(i - 1)) ** 2 +
          (positions.getZ(i) - positions.getZ(i - 1)) ** 2,
      );
    }
    this.flowOffset = this.options.spacing > 0
      ? ((this.flowOffset % this.options.spacing) + this.options.spacing) % this.options.spacing
      : 0;
    this.placeDots();
    this.object.visible = this.totalLength > 0;
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  onResize(width: number, height: number): void {
    (this.material.uniforms.uResolution.value as THREE.Vector2).set(width, height);
  }

  update(time: number): void {
    if (!this.cachedPoints || this.totalLength <= 0 || this.options.spacing <= 0) return;
    const nextOffset = (time * this.options.flowSpeed) % this.options.spacing;
    if (nextOffset === this.lastFlowOffset) return;
    this.flowOffset = nextOffset;
    this.placeDots();
  }

  dispose(): void {
    this.pathGeometry.dispose();
    this.dotGeometry.dispose();
    this.material.dispose();
  }

  private placeDots(): void {
    const positions = this.pathGeometry.attributes.position;
    const spacing = this.options.spacing;
    if (spacing <= 0 || this.totalLength <= 0) {
      this.object.count = 0;
      return;
    }

    let count = 0;
    let nextInSegment = this.flowOffset;
    let distanceBeforeSegment = 0;
    for (let segment = 1; segment < positions.count && count < this.options.maxDots; segment += 1) {
      this.segmentStart.fromBufferAttribute(positions, segment - 1);
      this.segmentEnd.fromBufferAttribute(positions, segment);
      this.direction.subVectors(this.segmentEnd, this.segmentStart);
      const segmentLength = this.direction.length();
      if (segmentLength === 0) continue;
      this.direction.multiplyScalar(1 / segmentLength);

      while (nextInSegment <= segmentLength && count < this.options.maxDots) {
        this.cachedPosition.copy(this.segmentStart).addScaledVector(this.direction, nextInSegment);
        const base = count * 16;
        this.matrixArray[base] = 1;
        this.matrixArray[base + 1] = 0;
        this.matrixArray[base + 2] = 0;
        this.matrixArray[base + 3] = 0;
        this.matrixArray[base + 4] = 0;
        this.matrixArray[base + 5] = 1;
        this.matrixArray[base + 6] = 0;
        this.matrixArray[base + 7] = 0;
        this.matrixArray[base + 8] = 0;
        this.matrixArray[base + 9] = 0;
        this.matrixArray[base + 10] = 1;
        this.matrixArray[base + 11] = 0;
        this.matrixArray[base + 12] = this.cachedPosition.x;
        this.matrixArray[base + 13] = this.cachedPosition.y;
        this.matrixArray[base + 14] = this.cachedPosition.z;
        this.matrixArray[base + 15] = 1;
        this.aT.array[count] = this.totalLength > 0
          ? Math.min(1, (distanceBeforeSegment + nextInSegment) / this.totalLength)
          : 0;
        count += 1;
        nextInSegment += spacing;
      }
      if (Math.abs(nextInSegment - segmentLength) < 1e-7) {
        nextInSegment = spacing;
      } else {
        nextInSegment -= segmentLength;
      }
      distanceBeforeSegment += segmentLength;
    }

    this.lastFlowOffset = this.flowOffset;
    this.object.count = count;
    this.object.instanceMatrix.needsUpdate = true;
    this.aT.needsUpdate = true;
  }
}
