import { Vector3, Box3 } from "three";
import { DBSCAN } from "density-clustering";
import createKDTree from "static-kdtree";

interface SemanticToken {
  id: string;
  label: string;
  worldPos: Vector3;
}
type Point3D = [number, number, number];

// export default class GeometricContextManager {
//     private globalMemory: Map<string, SemanticToken> = new Map();
//     private readonly THRESHOLD = 0.5; // 0.5 meters radius for duplicates

//     // Checks if a 3D point is near an existing object
//     public findExistingObject(pos: Vector3): SemanticToken | null {
//         for (const token of this.globalMemory.values()) {
//             if (pos.distanceTo(token.worldPos) < this.THRESHOLD) {
//                 return token;
//             }
//         }
//         return null;
//     }

//     public addToken(token: SemanticToken) {
//         this.globalMemory.set(token.id, token);
//     }

//     public getMemory() {
//         return Array.from(this.globalMemory.values());
//     }
// }

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

  // public registerObjectPoints(className: string, rawPoints: Vector3[]) {
  //   // Strict gatekeeper: disregard anything that isn't a robust sofa point cloud cluster
  //   if (className !== "sofa" || rawPoints.length < 30) return;

  //   // Convert Three.js vectors to native coordinates matrix format [[x,y,z], [x,y,z]]
  //   const dataset = rawPoints.map((p) => [p.x, p.y, p.z]);

  //   // Run high-speed spatial clustering (0.4m radius threshold, min 15 points)
  //   const dbscan = new DBSCAN();
  //   const clusters = dbscan.run(dataset, 0.4, 15);

  //   for (const clusterIndices of clusters) {
  //     const instancePoints = clusterIndices.map((idx) => rawPoints[idx]);
  //     this.sofaInstances.push(instancePoints);
  //   }
  // }

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


  // public registerObjectPoints(className: string, rawPoints: Vector3[]) {
  //   if (rawPoints.length < 10) return;

  //   const dataset = rawPoints.map((p) => [p.x, p.y, p.z]);
  //   const dbscan = new DBSCAN();

  //   // 0.4m radius, 10 points minimum to form a cluster
  //   const clusters = dbscan.run(dataset, 0.4, 10);

  //   if (!this.spatialDatabase.has(className)) {
  //     this.spatialDatabase.set(className, []);
  //   }

  //   const instances = this.spatialDatabase.get(className)!;

  //   for (const clusterIndices of clusters) {
  //     const instancePoints = clusterIndices.map((idx) => rawPoints[idx]);
  //     instances.push(instancePoints);
  //   }
  // }

  public getTargetInstance(className: string, userPosition: Vector3) {
    const instances = this.spatialDatabase.get(className);
    if (!instances || instances.length === 0) return null;

    // Find the instance whose centroid is closest to the user
    let bestInstance = instances[0];
    let minDistance = Infinity;

    instances.forEach((instance) => {
      const centroid = this.calculateCentroid(instance);
      const dist = centroid.distanceTo(userPosition);
      if (dist < minDistance) {
        minDistance = dist;
        bestInstance = instance;
      }
    });

    const centroid = this.calculateCentroid(bestInstance);
    const box = new Box3().setFromPoints(bestInstance);
    const size = new Vector3();
    box.getSize(size);

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

        const dataset = rawPoints.map(p => [p.x, p.y, p.z]);
        const dbscan = new DBSCAN();
        const clusters = dbscan.run(dataset, 0.4, 10); // 0.4m radius, min 10 points

        if (!this.instanceCounters.has(className)) {
            this.instanceCounters.set(className, 0);
        }

        for (const clusterIndices of clusters) {
            const instancePoints = clusterIndices.map(idx => rawPoints[idx]);
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
                size
            };

            this.spatialDatabase.set(uniqueId, instance);
            console.log(`Registered spatial instance: ${uniqueId} with ${instancePoints.length} points.`);
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


  // public registerAndMeasureObject(
  //   className: string,
  //   rawPoints: Vector3[],
  //   options?: { eps?: number; minPts?: number },
  // ) {
  //   const eps = options?.eps ?? 0.3;
  //   const minPts = options?.minPts ?? 10;
  //   if (rawPoints.length < minPts) return null;

  //   // 2. Explicitly type the dataset as an array of 3D tuples
  //   const dataset: Point3D[] = rawPoints.map((p) => [p.x, p.y, p.z]);

  //   // 3. Instantiate the tree with the explicit dimension parameter <3>
  //   const tree = createKDTree<3>(dataset);

  //   const visited = new Set<number>();
  //   const clusters: number[][] = [];
  //   const noise = new Set<number>();

  //   // Helper function using the native .rnn signature matching your .d.ts
  //   const getNeighborsWithinRadius = (
  //     point: Point3D,
  //     radius: number,
  //   ): number[] => {
  //     const resultIndices: number[] = [];

  //     // rnn(point: TupleOf<number, 3>, radius: number, visit: (id: number) => any): void;
  //     tree.rnn(point, radius, (id: number) => {
  //       resultIndices.push(id);
  //     });

  //     return resultIndices;
  //   };

  //   // 4. Custom DBSCAN loop accelerated by the K-d tree
  //   for (let i = 0; i < dataset.length; i++) {
  //     if (visited.has(i)) continue;
  //     visited.add(i);

  //     const neighbors = getNeighborsWithinRadius(dataset[i], eps);

  //     if (neighbors.length < minPts) {
  //       noise.add(i);
  //     } else {
  //       const cluster: number[] = [];
  //       expandCluster(i, neighbors, cluster);
  //       clusters.push(cluster);
  //     }
  //   }

  //   function expandCluster(
  //     pointIdx: number,
  //     neighbors: number[],
  //     cluster: number[],
  //   ) {
  //     cluster.push(pointIdx);

  //     for (let i = 0; i < neighbors.length; i++) {
  //       const nextPointIdx = neighbors[i];

  //       if (!visited.has(nextPointIdx)) {
  //         visited.add(nextPointIdx);
  //         const nextNeighbors = getNeighborsWithinRadius(
  //           dataset[nextPointIdx],
  //           eps,
  //         );

  //         if (nextNeighbors.length >= minPts) {
  //           for (const n of nextNeighbors) {
  //             if (!neighbors.includes(n)) {
  //               neighbors.push(n);
  //             }
  //           }
  //         }
  //       }

  //       if (!clusters.some((c) => c.includes(nextPointIdx))) {
  //         cluster.push(nextPointIdx);
  //       }
  //     }
  //   }

  //   // 5. Clean up memory allocations directly from your definition file
  //   tree.dispose();

  //   if (clusters.length === 0) return null;

  //   // 6. Extrapolate the main cluster and boundaries
  //   const mainClusterIndices = clusters.reduce((prev, curr) =>
  //     curr.length > prev.length ? curr : prev,
  //   );

  //   const mainObjectPoints = mainClusterIndices.map((idx) => rawPoints[idx]);
  //   const box = new Box3().setFromPoints(mainObjectPoints);
  //   const size = new Vector3();
  //   box.getSize(size);

  //   return {
  //     label: className,
  //     dimensions: { width: size.x, height: size.y, depth: size.z },
  //     centroid: box.getCenter(new Vector3()),
  //     points: mainObjectPoints,
  //     box,
  //   };
  // }
}
