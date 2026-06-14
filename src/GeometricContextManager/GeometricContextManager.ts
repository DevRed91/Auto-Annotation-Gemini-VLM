import { Vector3 } from "three";

interface SemanticToken {
    id: string;
    label: string;
    worldPos: Vector3;
}

export default class GeometricContextManager {
    private globalMemory: Map<string, SemanticToken> = new Map();
    private readonly THRESHOLD = 0.5; // 0.5 meters radius for duplicates

    // Checks if a 3D point is near an existing object
    public findExistingObject(pos: Vector3): SemanticToken | null {
        for (const token of this.globalMemory.values()) {
            if (pos.distanceTo(token.worldPos) < this.THRESHOLD) {
                return token;
            }
        }
        return null;
    }

    public addToken(token: SemanticToken) {
        this.globalMemory.set(token.id, token);
    }

    public getMemory() {
        return Array.from(this.globalMemory.values());
    }
}