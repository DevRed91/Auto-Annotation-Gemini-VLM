import type { EditRecord, FlawClass, LiftResult } from "./types";
import { GaussianStore } from "./GaussianStore";
const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));
const logit = (value: number) => {
  const clamped = Math.max(1e-7, Math.min(1 - 1e-7, value));
  return Math.log(clamped / (1 - clamped));
};
const opacityClasses = new Set<FlawClass>(["Floater", "Haze", "Ghosting"]);
export function rectificationNotice(flaw: FlawClass): string | null {
  if (flaw === "Specular Collapse")
    return "Specular Collapse SH editing is not implemented yet.";
  if (["Structure Missing", "Over-smooth", "HF Blur"].includes(flaw))
    return "Flag only: this flaw requires densification, which is not supported.";
  return null;
}
export class RectificationHistory {
  private undoStack: EditRecord[][] = [];
  private redoStack: EditRecord[][] = [];
  apply(store: GaussianStore, result: LiftResult): EditRecord[] {
    if (rectificationNotice(result.class))
      return [];
    if (result.detached.length !== result.indices.length || (result.votes && result.votes.length !== result.indices.length)) {
      throw new Error("Lift metadata must match selected indices");
    }
    const rows = Array.from(result.indices, (index, row) => ({ index, row }));
    const candidates = rows.filter(({ index, row }) => !store.isPruned[index] && result.detached[row]);
    candidates.sort((a, b) => (result.votes?.[b.row] ?? 0) - (result.votes?.[a.row] ?? 0) || a.index - b.index);
    const prune = new Set<number>();
    if (result.class === "Floater" || result.class === "Needle Stretch") {
      for (const { index } of candidates) {
        if (prune.size >= Math.floor(store.vertexCount * 0.02))
          break;
        prune.add(index);
      }
    }
    const edits = new Map<string, {
      indices: number[];
      previous: number[];
      next: number[];
    }>();
    const record = (index: number, property: string, next: number) => {
      const previous = property === "$pruned" ? store.isPruned[index] : store.get(index, property);
      if (!Number.isFinite(previous) || !Number.isFinite(next) || previous === next)
        return;
      const edit = edits.get(property) ?? { indices: [], previous: [], next: [] };
      edit.indices.push(index);
      edit.previous.push(previous);
      edit.next.push(next);
      edits.set(property, edit);
    };
    const seen = new Set<number>();
    for (const { index, row } of rows) {
      if (seen.has(index) || store.isPruned[index])
        continue;
      seen.add(index);
      if (prune.has(index)) {
        record(index, "$pruned", 1);
        continue;
      }
      if (!result.detached[row] && opacityClasses.has(result.class)) {
        record(index, "opacity", logit(0.65 * sigmoid(store.get(index, "opacity"))));
      }
      if (result.class === "Ghosting" || (result.class === "Needle Stretch" && !result.detached[row])) {
        const axes = [0, 1, 2].map(axis => ({ axis, value: store.get(index, `scale_${axis}`) })).sort((a, b) => b.value - a.value);
        if (axes.every(axis => Number.isFinite(axis.value)) && (result.class !== "Ghosting" || axes[0].value - axes[1].value > Math.log(3))) {
          record(index, `scale_${axes[0].axis}`, axes[0].value + Math.log(result.class === "Ghosting" ? 0.9 : 0.75));
        }
      }
    }
    const records: EditRecord[] = Array.from(edits, ([property, edit]) => ({
      property, indices: Uint32Array.from(edit.indices),
      previousValues: Float64Array.from(edit.previous), nextValues: Float64Array.from(edit.next),
    }));
    if (records.length) {
      records.forEach(record => this.write(store, record, record.nextValues));
      this.undoStack.push(records);
      this.redoStack = [];
    }
    return records;
  }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  /** Returns the reverted group so callers can refresh the affected splats. */
  undo(store: GaussianStore): EditRecord[] | undefined {
    const group = this.undoStack.pop();
    if (!group)
      return undefined;
    group.slice().reverse().forEach(record => this.write(store, record, record.previousValues));
    this.redoStack.push(group);
    return group;
  }
  redo(store: GaussianStore): EditRecord[] | undefined {
    const group = this.redoStack.pop();
    if (!group)
      return undefined;
    group.forEach(record => this.write(store, record, record.nextValues));
    this.undoStack.push(group);
    return group;
  }
  private write(store: GaussianStore, record: EditRecord, values: ArrayLike<number>): void {
    record.indices.forEach((index, row) => {
      if (record.property === "$pruned")
        store.markPruned(index, Boolean(values[row]));
      else
        store.set(index, record.property, values[row]);
    });
  }
}
