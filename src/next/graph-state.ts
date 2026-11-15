export interface GraphState {
  selectedId: string | null; focusId: string | null; collapsed: string[];
  camera: {x: number; y: number; zoom: number} | null;
}
export const emptyGraph = (): GraphState => ({selectedId: null, focusId: null, collapsed: [], camera: null});
export function validGraph(value: unknown, nodeIds?: string[]): value is GraphState {
  const graph = value as GraphState;
  const validId = (id: unknown) => typeof id === 'string' && (!nodeIds || nodeIds.includes(id));
  return !!graph && Array.isArray(graph.collapsed) && graph.collapsed.every(validId)
    && [graph.selectedId, graph.focusId].every(id => id === null || validId(id))
    && (graph.camera === null || (!!graph.camera && [graph.camera.x, graph.camera.y, graph.camera.zoom].every(Number.isFinite) && graph.camera.zoom >= .2 && graph.camera.zoom <= 2));
}
