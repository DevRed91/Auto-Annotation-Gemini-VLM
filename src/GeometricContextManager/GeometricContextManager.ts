import { Vector3, Box3 } from "three";
import { DBSCAN } from "density-clustering";

interface SemanticToken {
  id: string;
  label: string;
  worldPos: Vector3;
}

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

export default class GeometricContextManager {
  // Stores array of instances, where each instance is an array of Three.js Vector3 points
  private sofaInstances: Vector3[][] = [];

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
    if (this.sofaInstances.length !== 0)
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
  private spatialDatabase: Map<string, Vector3[][]> = new Map();

    public registerObjectPoints(className: string, rawPoints: Vector3[]) {
        if (rawPoints.length < 10) return;

        const dataset = rawPoints.map(p => [p.x, p.y, p.z]);
        const dbscan = new DBSCAN();
        
        // 0.4m radius, 10 points minimum to form a cluster
        const clusters = dbscan.run(dataset, 0.4, 10);

        if (!this.spatialDatabase.has(className)) {
            this.spatialDatabase.set(className, []);
        }

        const instances = this.spatialDatabase.get(className)!;

        for (const clusterIndices of clusters) {
            const instancePoints = clusterIndices.map(idx => rawPoints[idx]);
            instances.push(instancePoints);
        }
    }

    public getTargetInstance(className: string, userPosition: Vector3) {
        const instances = this.spatialDatabase.get(className);
        if (!instances || instances.length === 0) return null;

        // Find the instance whose centroid is closest to the user
        let bestInstance = instances[0];
        let minDistance = Infinity;

        instances.forEach(instance => {
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

}
