import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

export interface PolyLineOptions {
  maxPoints?: number;
  linewidthPixels?: number;
  color?: THREE.ColorRepresentation;
  opacity?: number;
}

const DEFAULTS = {
  maxPoints: 256,
  linewidthPixels: 28,
  color: 0x3fe0ff,
  opacity: 1,
};

/** A preallocated, screen-space dotted polyline. */
export class PolyLine {
  readonly object: Line2;

  private readonly geometry: LineGeometry;
  private readonly material: LineMaterial;
  private readonly positionBuffer: THREE.InstancedInterleavedBuffer;
  private readonly tBuffer: THREE.InstancedInterleavedBuffer;
  private readonly positionArray: Float32Array;
  private readonly tArray: Float32Array;
  private readonly mv = new THREE.Matrix4();
  private readonly mvp = new THREE.Matrix4();
  private readonly tmp = new THREE.Vector4();
  private px = 0;
  private py = 0;

  constructor(options: PolyLineOptions = {}) {
    const opts = { ...DEFAULTS, ...options };
    const maxSegments = Math.max(1, Math.floor(opts.maxPoints) - 1);

    this.geometry = new LineGeometry();
    this.positionArray = new Float32Array(maxSegments * 6);
    this.positionBuffer = new THREE.InstancedInterleavedBuffer(
      this.positionArray,
      6,
      1,
    );
    this.positionBuffer.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute(
      "instanceStart",
      new THREE.InterleavedBufferAttribute(this.positionBuffer, 3, 0),
    );
    this.geometry.setAttribute(
      "instanceEnd",
      new THREE.InterleavedBufferAttribute(this.positionBuffer, 3, 3),
    );

    this.tArray = new Float32Array(maxSegments * 2);
    this.tBuffer = new THREE.InstancedInterleavedBuffer(this.tArray, 2, 1);
    this.tBuffer.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute(
      "instanceTStart",
      new THREE.InterleavedBufferAttribute(this.tBuffer, 1, 0),
    );
    this.geometry.setAttribute(
      "instanceTEnd",
      new THREE.InterleavedBufferAttribute(this.tBuffer, 1, 1),
    );
    this.geometry.instanceCount = 0;

    this.material = new LineMaterial({
      transparent: true,
      blending: THREE.NormalBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      linewidth: opts.linewidthPixels,
    });
    this.material.worldUnits = false;
    this.material.resolution.set(window.innerWidth, window.innerHeight);
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uColor = { value: new THREE.Color(opts.color) };
      shader.uniforms.uOpacity = { value: opts.opacity };

      shader.vertexShader = shader.vertexShader
        .replace(
          "attribute vec3 instanceEnd;",
          "attribute vec3 instanceEnd;\nattribute float instanceTStart;\nattribute float instanceTEnd;\nvarying float vT;\nvarying float vW;\nvarying float vLen;",
        )
        .replace(
          "gl_Position = clip;",
          // instanceTStart/End hold cumulative screen-space pixel distance (see updatePixelDistances).
          // Here we use the distance local to this segment. Pre-multiplying by w (and dividing by
          // the interpolated w in the fragment shader) cancels perspective-correct interpolation,
          // giving screen-linear distance.
          "float tLocal = ( position.y < 0.5 ) ? 0.0 : ( instanceTEnd - instanceTStart );\n\t\t\tvT = tLocal * clip.w;\n\t\t\tvW = clip.w;\n\t\t\tvLen = instanceTEnd - instanceTStart;\n\t\t\tgl_Position = clip;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "uniform float linewidth;",
          "uniform float linewidth;\n\t\tuniform vec3 uColor;\n\t\tuniform float uOpacity;\n\t\tvarying float vT;\n\t\tvarying float vW;\n\t\tvarying float vLen;",
        )
        .replace("if ( len2 > 1.0 ) discard;", "")
        .replace(
          "gl_FragColor = vec4( diffuseColor.rgb, alpha );",
          `// Endcaps extend past the endpoints by (linewidth/2) px per uv unit.
          float capOff = vUv.y > 1.0 ? vUv.y - 1.0 : ( vUv.y < -1.0 ? vUv.y + 1.0 : 0.0 );
          float t = vT / vW + capOff * linewidth * 0.5;
          // Whole number of evenly spaced dots per segment, with one centred on each endpoint,
          // so adjoining segments draw the identical dot at a joint.
          float n = max( floor( vLen / linewidth + 0.5 ), 1.0 );
          float spacing = max( vLen / n, 1.0 );
          float phase = fract( t / spacing + 0.5 );
          float along = abs( phase - 0.5 ) * spacing / ( linewidth * 0.5 );
          float radius = length( vec2( vUv.x, along ) );
          float dotAlpha = 1.0 - smoothstep( 0.32, 0.5, radius );
          gl_FragColor = vec4( uColor, alpha * dotAlpha * uOpacity );`,
        );
    };

    this.object = new Line2(this.geometry, this.material);
    this.object.renderOrder = 999;
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.object.onBeforeRender = (_renderer, _scene, camera) =>
      this.updatePixelDistances(camera);
  }

  /**
   * Writes cumulative screen-space distance (px) per segment endpoint so the
   * dot pattern runs continuously across joints. Camera-dependent, so it is
   * refreshed every render.
   */
  private updatePixelDistances(camera: THREE.Camera): void {
    const segments = this.geometry.instanceCount;
    if (segments <= 0) return;

    const mvp = this.mvp.multiplyMatrices(
      camera.projectionMatrix,
      this.mv.multiplyMatrices(camera.matrixWorldInverse, this.object.matrixWorld),
    );
    const halfW = this.material.resolution.x * 0.5;
    const halfH = this.material.resolution.y * 0.5;
    const p = this.tmp;
    const project = (offset: number): void => {
      p.set(
        this.positionArray[offset],
        this.positionArray[offset + 1],
        this.positionArray[offset + 2],
        1,
      ).applyMatrix4(mvp);
      const w = Math.max(Math.abs(p.w), 1e-6);
      this.px = (p.x / w) * halfW;
      this.py = (p.y / w) * halfH;
    };

    let distance = 0;
    project(0);
    for (let i = 0; i < segments; i += 1) {
      const sx = this.px;
      const sy = this.py;
      project(i * 6 + 3);
      this.tArray[i * 2] = distance;
      distance += Math.hypot(this.px - sx, this.py - sy);
      this.tArray[i * 2 + 1] = distance;
    }
    this.tBuffer.needsUpdate = true;
  }

  setEndpoints(a: THREE.Vector3, b: THREE.Vector3): void {
    this.writePoints(a, b);
  }

  setPoints(points: readonly THREE.Vector3[]): void {
    if (points.length < 2) {
      this.object.visible = false;
      return;
    }

    const count = Math.min(points.length, this.tBuffer.count + 1);

    for (let i = 0; i < count - 1; i += 1) {
      const start = points[i];
      const end = points[i + 1];
      const positionOffset = i * 6;
      this.positionArray[positionOffset] = start.x;
      this.positionArray[positionOffset + 1] = start.y;
      this.positionArray[positionOffset + 2] = start.z;
      this.positionArray[positionOffset + 3] = end.x;
      this.positionArray[positionOffset + 4] = end.y;
      this.positionArray[positionOffset + 5] = end.z;
    }

    this.geometry.instanceCount = count - 1;
    this.positionBuffer.needsUpdate = true;
    this.tBuffer.needsUpdate = true;
    this.object.visible = true;
  }

  setVisible(visible: boolean): void { this.object.visible = visible; }

  onResize(width: number, height: number): void { this.material.resolution.set(width, height); }

  update(_time: number): void {}

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private writePoints(a: THREE.Vector3, b: THREE.Vector3): void {
    this.positionArray[0] = a.x;
    this.positionArray[1] = a.y;
    this.positionArray[2] = a.z;
    this.positionArray[3] = b.x;
    this.positionArray[4] = b.y;
    this.positionArray[5] = b.z;
    this.geometry.instanceCount = 1;
    this.positionBuffer.needsUpdate = true;
    this.tBuffer.needsUpdate = true;
    this.object.visible = true;
  }
}
