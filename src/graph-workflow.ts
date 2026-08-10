import type {
  GraphWorkflowDefinition,
  GraphWorkflowEdge,
  GraphWorkflowNode,
  GraphWorkflowOutcome,
  GraphWorkflowTemplate,
} from './models.js';

const reviewTestRelease: GraphWorkflowTemplate = {
  template_id: 'review-test-release',
  template_name: '开发 → Review → E2E → 发布复核',
  description: 'Coder 完成后交 Reviewer；Review/E2E 均可打回 Coder；全部通过后由 Reviewer 执行最终上传流程。',
  version: 1,
  definition: {
    kind: 'graph',
    version: 1,
    template_id: 'review-test-release',
    template_name: '开发 → Review → E2E → 发布复核',
    entry_node_id: 'implement',
    nodes: [
      {
        node_id: 'implement',
        title: '实现',
        assignees: ['$assignee'],
        action: '完成任务实现与对应回归测试，并提交可供 Review 的结果。',
        completion: 'all',
      },
      {
        node_id: 'review',
        title: '代码 Review',
        assignees: ['role:reviewer'],
        action: '审查实现、测试和边界；通过或带明确原因打回实现节点。',
        completion: 'all',
      },
      {
        node_id: 'e2e',
        title: 'E2E 验证',
        assignees: ['role:tester'],
        action: '运行真实 E2E，记录证据；通过或带明确原因打回实现节点。',
        completion: 'all',
      },
      {
        node_id: 'release-review',
        title: '发布复核',
        assignees: ['role:reviewer'],
        action: '复核 Review 与 E2E 证据；仅在已有发布授权时执行上传/发布流程。',
        completion: 'all',
      },
    ],
    edges: [
      { edge_id: 'implement-passed-review', from: 'implement', to: 'review', when: 'passed' },
      { edge_id: 'review-changes-implement', from: 'review', to: 'implement', when: 'changes_requested' },
      { edge_id: 'review-passed-e2e', from: 'review', to: 'e2e', when: 'passed' },
      { edge_id: 'e2e-changes-implement', from: 'e2e', to: 'implement', when: 'changes_requested' },
      { edge_id: 'e2e-passed-release', from: 'e2e', to: 'release-review', when: 'passed' },
      { edge_id: 'release-changes-implement', from: 'release-review', to: 'implement', when: 'changes_requested' },
    ],
  },
};

export const BUILTIN_WORKFLOW_TEMPLATES: readonly GraphWorkflowTemplate[] = [reviewTestRelease];

export function getBuiltinWorkflowTemplate(templateId: string): GraphWorkflowTemplate | undefined {
  return BUILTIN_WORKFLOW_TEMPLATES.find(template => template.template_id === templateId);
}

export function isGraphWorkflowDefinition(value: unknown): value is GraphWorkflowDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<GraphWorkflowDefinition>;
  return candidate.kind === 'graph'
    && candidate.version === 1
    && typeof candidate.entry_node_id === 'string'
    && Array.isArray(candidate.nodes)
    && Array.isArray(candidate.edges);
}

export function parseGraphWorkflow(json: string | null): GraphWorkflowDefinition | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json);
    return isGraphWorkflowDefinition(value) ? value : null;
  } catch {
    return null;
  }
}

export function validateGraphWorkflow(definition: GraphWorkflowDefinition): void {
  if (definition.nodes.length === 0) throw new Error('Graph workflow has no nodes');
  const nodeIds = new Set<string>();
  for (const node of definition.nodes) {
    if (!node.node_id.trim()) throw new Error('Graph node_id cannot be empty');
    if (nodeIds.has(node.node_id)) throw new Error(`Duplicate graph node_id: ${node.node_id}`);
    if (node.assignees.length === 0) throw new Error(`Graph node has no assignees: ${node.node_id}`);
    nodeIds.add(node.node_id);
  }
  if (!nodeIds.has(definition.entry_node_id)) throw new Error(`Entry node not found: ${definition.entry_node_id}`);

  const edgeIds = new Set<string>();
  const conditions = new Set<string>();
  for (const edge of definition.edges) {
    if (edgeIds.has(edge.edge_id)) throw new Error(`Duplicate graph edge_id: ${edge.edge_id}`);
    if (!nodeIds.has(edge.from)) throw new Error(`Graph edge source not found: ${edge.from}`);
    if (!nodeIds.has(edge.to)) throw new Error(`Graph edge target not found: ${edge.to}`);
    const condition = `${edge.from}:${edge.when}`;
    if (conditions.has(condition)) throw new Error(`Ambiguous graph edges for ${condition}`);
    edgeIds.add(edge.edge_id);
    conditions.add(condition);
  }
}

export function graphNode(definition: GraphWorkflowDefinition, nodeId: string): GraphWorkflowNode {
  const node = definition.nodes.find(candidate => candidate.node_id === nodeId);
  if (!node) throw new Error(`Graph node not found: ${nodeId}`);
  return node;
}

export function graphNodeAt(definition: GraphWorkflowDefinition, index: number): GraphWorkflowNode {
  const node = definition.nodes[index - 1];
  if (!node) throw new Error(`Graph node index out of range: ${index}`);
  return node;
}

export function graphNodeIndex(definition: GraphWorkflowDefinition, nodeId: string): number {
  const index = definition.nodes.findIndex(node => node.node_id === nodeId);
  if (index < 0) throw new Error(`Graph node not found: ${nodeId}`);
  return index + 1;
}

export function graphEdge(
  definition: GraphWorkflowDefinition,
  from: string,
  outcome: GraphWorkflowOutcome,
): GraphWorkflowEdge | undefined {
  return definition.edges.find(edge => edge.from === from && edge.when === outcome);
}
