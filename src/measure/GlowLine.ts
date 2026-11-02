import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

export interface GlowLineOptions {
  linewidthPixels?: number;
  coreColor?: THREE.ColorRepresentation;
  glowColor?: THREE.ColorRepresentation;
  coreWidth?: number;
  falloff?: number;
  glowStrength?: number;
  opacity?: number;
}

const DEFAULTS: Required<GlowLineOptions> = {
  linewidthPixels: 28,
  coreColor: 0xeaf6ff,
  glowColor: 0x3fa9ff,
  coreWidth: 0.12,
  falloff: 4.5,
  glowStrength: 0.6,
  opacity: 1.0,
};

/**
 * Screen-space constant-width glowing line, built by patching three.js's
 * LineMaterial fragment shader (additive core + exponential halo) rather
 * than writing a ribbon shader from scratch. See MEASURE_LINE_PLAN.md §3.
 */
export class GlowLine {
  readonly object: Line2;
  private readonly geometry: LineGeometry;
  private readonly material: LineMaterial;
  private readonly uTime = { value: 0 };
  private readonly start = new THREE.Vector3();
  private readonly end = new THREE.Vector3();

  constructor(options: GlowLineOptions = {}) {
    const opts = { ...DEFAULTS, ...options };

    this.geometry = new LineGeometry();
    this.geometry.setPositions([0, 0, 0, 0, 0, 0]);

    this.material = new LineMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      linewidth: opts.linewidthPixels,
    });
    this.material.worldUnits = false;
    this.material.resolution.set(window.innerWidth, window.innerHeight);

    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uCoreWidth = { value: opts.coreWidth };
      shader.uniforms.uFalloff = { value: opts.falloff };
      shader.uniforms.uGlowStrength = { value: opts.glowStrength };
      shader.uniforms.uGlowColor = { value: new THREE.Color(opts.glowColor) };
      shader.uniforms.uCoreColor = { value: new THREE.Color(opts.coreColor) };
      shader.uniforms.uOpacity = { value: opts.opacity };
      shader.uniforms.uTime = this.uTime;

      shader.fragmentShader = shader.fragmentShader
        .replace(
          "uniform float linewidth;",
          `uniform float linewidth;
          uniform float uCoreWidth;
          uniform float uFalloff;
          uniform float uGlowStrength;
          uniform vec3 uGlowColor;
          uniform vec3 uCoreColor;
          uniform float uOpacity;
          uniform float uTime;`,
        )
        // Let the halo bleed past the stock rounded-cap cutoff instead of
        // hard-discarding at the cap edge.
        .replace("if ( len2 > 1.0 ) discard;", "")
        .replace(
          "gl_FragColor = vec4( diffuseColor.rgb, alpha );",
          `float a = vUv.x;
          float b = ( abs( vUv.y ) > 1.0 ) ? ( vUv.y > 0.0 ? vUv.y - 1.0 : vUv.y + 1.0 ) : 0.0;
          float r = sqrt( a * a + b * b );
          float core = smoothstep( uCoreWidth, 0.0, r );
          float halo = exp( -uFalloff * r * r );
          vec3 col = mix( uGlowColor, uCoreColor, core );
          gl_FragColor = vec4( col, ( core + halo * uGlowStrength ) * uOpacity );`,
        );
    };

    this.object = new Line2(this.geometry, this.material);
    this.object.renderOrder = 999;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  setEndpoints(start: THREE.Vector3, end: THREE.Vector3): void {
    this.setPoints([start, end]);
  }

  setPoints(points: readonly THREE.Vector3[]): void {
    if (points.length < 2) {
      this.object.visible = false;
      return;
    }

    // LineGeometry chains consecutive points into one continuous polyline
    // (it builds the start/end instance pairs internally), so clicked points
    // can be passed straight through.
    this.start.copy(points[0]);
    this.end.copy(points[points.length - 1]);
    this.geometry.setFromPoints(points as THREE.Vector3[]);
    this.object.computeLineDistances();
    this.object.visible = true;
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  onResize(width: number, height: number): void {
    this.material.resolution.set(width, height);
  }

  update(time: number): void {
    this.uTime.value = time;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
