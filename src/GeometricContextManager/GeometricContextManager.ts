import { SemanticToken } from "../utils/types";

export default class GeometricContextManager {
    // 1. Anchor Context: The "Ground Truth" for the scene scale
    private anchor: SemanticToken | null = null;
    
    // 2. Pose-Reference Window (Local): Last K detections for smoothing
    private localWindow: SemanticToken[] = [];
    private readonly windowSize = 5;

    // 3. Trajectory Memory (Global): Compressed 3D database
    private globalMemory: Map<string, SemanticToken> = new Map();

    public integrate(newToken: SemanticToken) {
        // Step A: Set Anchor if first detection (LingBot-Map Rule 1)
        if (!this.anchor) {
            this.anchor = newToken;
            console.log("Anchor Context Set:", newToken.label);
        }

        // Step B: Local Window Consensus (LingBot-Map Rule 2)
        // We only accept the token if it aligns with local neighbors
        // if (this.isLocallyConsistent(newToken)) {
        //     this.updateGlobalMemory(newToken);
        // }

        // Maintain sliding window
        this.localWindow.push(newToken);
        if (this.localWindow.length > this.windowSize) this.localWindow.shift();
    }

    private isLocallyConsistent(token: SemanticToken): boolean {
        if (this.localWindow.length === 0) return true;
        
        // Find nearest neighbor in the local window
        const nearest = this.localWindow.reduce((prev, curr) => 
            token.worldPos.distanceTo(prev.worldPos) < token.worldPos.distanceTo(curr.worldPos) ? prev : curr
        );

        // If the new detection is > 1m from local neighbors, it might be drift/noise
        return token.worldPos.distanceTo(nearest.worldPos) < 1.0;
    }

    private updateGlobalMemory(token: SemanticToken) {
        // Clustering: If this token is near an existing object in global memory, merge them
        let merged = false;
        this.globalMemory.forEach((existing, id) => {
            if (token.worldPos.distanceTo(existing.worldPos) < 0.05) {
                // Moving Average for 3D position (Temporal Consistency)
                existing.worldPos.lerp(token.worldPos, 0.2); 
                merged = true;
            }
        });

        if (!merged) {
            this.globalMemory.set(token.id, token);
        }
    }

    public getActiveObjects() {
        return Array.from(this.globalMemory.values());
    }
}