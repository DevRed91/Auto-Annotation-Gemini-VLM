import { Vector3 } from "three";

export interface SemanticToken {
  id: string;
  label: string;
  worldPos: Vector3;
  confidence: number;
  timestamp: number;
}
