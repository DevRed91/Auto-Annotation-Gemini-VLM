import { Vector3, Box3 } from "three";
import { DBSCAN } from "density-clustering";

export interface SemanticInstance {
  id: string;
  className: string;
  points: Vector3[];
  centroid: Vector3;
  boundingBox: Box3;
  size: Vector3;
}
export default class GeometricContextManager {
  // Stores array of instances, where each instance is an array of Three.js Vector3 points
  private sofaInstances: Vector3[][] = [];
  private spatialDatabase: Map<string, SemanticInstance> = new Map();
  private instanceCounters: Map<string, number> = new Map();
  /**
   * Finds the closest tracked sofa structure based on user position
   */
  public getTargetSofaInstance(userPosition: Vector3): {
    centroid: Vector3;
    size: Vector3;
  } {
    if (this.sofaInstances.length === 0)
      return { centroid: new Vector3(), size: new Vector3() };

    let closestInstance: Vector3[] = this.sofaInstances[0];
    let minDistance = Infinity;

    for (const instance of this.sofaInstances) {
      const center = this.calculateCentroid(instance);
      const dist = center.distanceTo(userPosition);
      if (dist < minDistance) {
        minDistance = dist;
        closestInstance = instance;
      }
    }

    const centroid = this.calculateCentroid(closestInstance);
    const box = new Box3().setFromPoints(closestInstance);
    const size = new Vector3();
    box.getSize(size);

    return { centroid, size };
  }

  private calculateCentroid(points: Vector3[]): Vector3 {
    const center = new Vector3(0, 0, 0);
    points.forEach((p) => center.add(p));
    return center.divideScalar(points.length);
  }

  public getTargetInstance(className: string, userPosition: Vector3) {
    const instances = Array.from(this.spatialDatabase.values()).filter(
      (inst) => inst.className === className
    );
    if (instances.length === 0) return null;

    // Find the instance whose centroid is closest to the user
    let bestInstance = instances[0];
    let minDistance = Infinity;

    instances.forEach((instance) => {
      const centroid = instance.centroid;
      const dist = centroid.distanceTo(userPosition);
      if (dist < minDistance) {
        minDistance = dist;
        bestInstance = instance;
      }
    });

    const centroid = bestInstance.centroid;
    const size = bestInstance.size;

    return { centroid, size };
  }
  public registerAndMeasureObject(
    className: string,
    rawPoints: Vector3[],
    options?: { eps?: number; minPts?: number },
  ) {
    const eps = options?.eps ?? 0.3;
    const minPts = options?.minPts ?? 10;
    if (rawPoints.length < minPts) return null;

    // 1. Convert to DBSCAN format [[x,y,z], ...]
    const dataset = rawPoints.map((p) => [p.x, p.y, p.z]);

    // 2. Run DBSCAN (0.3m radius, min 10 points)
    const dbscan = new DBSCAN();
    const clusters = dbscan.run(dataset, eps, minPts);

    if (clusters.length === 0) return null;

    // 3. Find the "Main" cluster (the one with the most points)
    // This is mathematically the most likely to be the actual sofa
    const mainClusterIndices = clusters.reduce((prev, curr) =>
      curr.length > prev.length ? curr : prev,
    );

    const mainObjectPoints = mainClusterIndices.map((idx) => rawPoints[idx]);

    // 4. Calculate Dimensions on the CLEAN cluster only
    const box = new Box3().setFromPoints(mainObjectPoints);
    const size = new Vector3();
    box.getSize(size);

    // 5. Store for the UI
    const result = {
      label: className,
      dimensions: {
        width: size.x,
        height: size.y,
        depth: size.z,
      },
      centroid: this.calculateCentroid(mainObjectPoints),
      points: mainObjectPoints,
      box,
    };
    console.log("Registered Object:", result);

    // this.spatialDatabase.set(className, clusters.map((cluster) => cluster.map((idx) => rawPoints[idx])));
    return result;
  }

  /**
   * Group raw spatial points into distinct, ID-stamped object structures
   */
  public registerObjectPoints(className: string, rawPoints: Vector3[]) {
    if (rawPoints.length < 10) return;

    const dataset = rawPoints.map((p) => [p.x, p.y, p.z]);
    const dbscan = new DBSCAN();
    const clusters = dbscan.run(dataset, 0.4, 10); // 0.4m radius, min 10 points

    if (!this.instanceCounters.has(className)) {
      this.instanceCounters.set(className, 0);
    }

    for (const clusterIndices of clusters) {
      const instancePoints = clusterIndices.map((idx) => rawPoints[idx]);
      const centroid = this.calculateCentroid(instancePoints);
      const boundingBox = new Box3().setFromPoints(instancePoints);
      const size = new Vector3();
      boundingBox.getSize(size);

      // Increment counter and generate unique ID matching the JSON (e.g. "sofa_1")
      const currentCount = this.instanceCounters.get(className)! + 1;
      this.instanceCounters.set(className, currentCount);
      const uniqueId = `${className}_${currentCount}`;

      const instance: SemanticInstance = {
        id: uniqueId,
        className,
        points: instancePoints,
        centroid,
        boundingBox,
        size,
      };

      this.spatialDatabase.set(uniqueId, instance);
      console.log(
        `Registered spatial instance: ${uniqueId} with ${instancePoints.length} points.`,
      );
    }
  }

  /**
   * Resolves a 3D raycast hit point to the closest registered semantic instance
   */
  public resolveInstanceAtPoint(hitPoint: Vector3): SemanticInstance | null {
    let matchedInstance: SemanticInstance | null = null;
    let minDistance = Infinity;

    for (const instance of this.spatialDatabase.values()) {
      // Check if the clicked point is inside the bounding box of the instance
      const isInsideBox = instance.boundingBox.containsPoint(hitPoint);
      const distanceToCentroid = instance.centroid.distanceTo(hitPoint);

      // Priority 1: Direct bounding box containment
      if (isInsideBox) {
        return instance;
      }

      // Priority 2: Proximity to centroid (with a threshold of 0.8 meters)
      if (distanceToCentroid < 0.8 && distanceToCentroid < minDistance) {
        minDistance = distanceToCentroid;
        matchedInstance = instance;
      }
    }

    return matchedInstance;
  }
}
