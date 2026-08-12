import type {
  GraphWorkflowDefinition,
  GraphWorkflowEdge,
  GraphWorkflowNode,
  GraphWorkflowOutcome,
  GraphWorkflowTemplate,
} from './models.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STORE_MARKER = '.initialized-v1';
const CONTEXT_MIGRATION_MARKER = '.migrated-context-v1';
const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function bundledTemplatesDir(): string {
  return fileURLToPath(new URL('../workflows', import.meta.url));
}

export function workflowTemplatesDir(): string {
  return process.env.KITTY_HIVE_WORKFLOWS_DIR || join(homedir(), '.kitty-hive', 'workflows');
}

function atomicWrite(path: string, content: string): void {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, path);
}

/** Seed packaged examples exactly once. The marker makes deleting a seeded
 * template durable instead of silently restoring it on every restart. */
export function ensureWorkflowTemplateStore(): string {
  const dir = workflowTemplatesDir();
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, STORE_MARKER);
  if (!existsSync(marker)) {
    const bundled = bundledTemplatesDir();
    if (existsSync(bundled)) {
      for (const file of readdirSync(bundled).filter(name => name.endsWith('.json')).sort()) {
        const target = join(dir, basename(file));
        if (!existsSync(target)) atomicWrite(target, readFileSync(join(bundled, file), 'utf8'));
      }
    }
    atomicWrite(marker, 'Workflow templates initialized by kitty-hive.\n');
  }
  migrateBundledTemplateContexts(dir);
  return dir;
}

/** Upgrade only the exact legacy packaged example. A user-edited or deleted
 * template is never replaced: the comparison removes context from the new
 * bundled JSON and requires every other byte-independent JSON value to match
 * the installed template before writing the upgrade. */
function migrateBundledTemplateContexts(dir: string): void {
  const marker = join(dir, CONTEXT_MIGRATION_MARKER);
  if (existsSync(marker)) return;
  const filename = 'review-test-release.json';
  const installedPath = join(dir, filename);
  const bundledPath = join(bundledTemplatesDir(), filename);
  if (existsSync(installedPath) && existsSync(bundledPath)) {
    try {
      const installed = JSON.parse(readFileSync(installedPath, 'utf8')) as GraphWorkflowTemplate;
      const current = JSON.parse(readFileSync(bundledPath, 'utf8')) as GraphWorkflowTemplate;
      const legacyShape = structuredClone(current);
      for (const node of legacyShape.definition.nodes) delete node.context;
      if (JSON.stringify(installed) === JSON.stringify(legacyShape)) {
        atomicWrite(installedPath, `${JSON.stringify(current, null, 2)}\n`);
      }
    } catch { /* invalid/custom templates remain untouched and surface via list */ }
  }
  atomicWrite(marker, 'Bundled workflow context migration checked.\n');
}

function templatePath(templateId: string): string {
  if (!TEMPLATE_ID_PATTERN.test(templateId)) {
    throw new Error(`Invalid workflow template id: ${templateId}`);
  }
  return join(ensureWorkflowTemplateStore(), `${templateId}.json`);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim().length > 0);
}

export function parseWorkflowTemplate(value: unknown): GraphWorkflowTemplate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Workflow template must be an object');
  const template = value as Partial<GraphWorkflowTemplate>;
  if (typeof template.template_id !== 'string' || !TEMPLATE_ID_PATTERN.test(template.template_id)) {
    throw new Error('Workflow template_id must match /^[a-z0-9][a-z0-9._-]*$/');
  }
  if (typeof template.template_name !== 'string' || !template.template_name.trim()) throw new Error('Workflow template_name cannot be empty');
  if (typeof template.description !== 'string') throw new Error('Workflow description must be a string');
  if (template.version !== 1) throw new Error('Workflow template version must be 1');
  if (!isGraphWorkflowDefinition(template.definition)) throw new Error('Workflow definition is not a graph v1 definition');
  if (template.definition.template_id !== template.template_id) throw new Error('Workflow definition template_id does not match template_id');
  if (template.definition.template_name !== template.template_name) throw new Error('Workflow definition template_name does not match template_name');
  validateGraphWorkflow(template.definition);
  return structuredClone(template as GraphWorkflowTemplate);
}

function readWorkflowTemplateFile(path: string): GraphWorkflowTemplate {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse workflow template ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const template = parseWorkflowTemplate(value);
    if (`${template.template_id}.json` !== basename(path)) {
      throw new Error(`filename must be ${template.template_id}.json`);
    }
    return template;
  } catch (error) {
    throw new Error(`Invalid workflow template ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Read on every call so CLI edits are hot-reloaded without restarting Hive. */
export function listWorkflowTemplates(): GraphWorkflowTemplate[] {
  const dir = ensureWorkflowTemplateStore();
  return readdirSync(dir)
    .filter(file => file.endsWith('.json'))
    .sort()
    .map(file => readWorkflowTemplateFile(join(dir, file)));
}

export function getWorkflowTemplate(templateId: string): GraphWorkflowTemplate | undefined {
  const path = templatePath(templateId);
  return existsSync(path) ? readWorkflowTemplateFile(path) : undefined;
}

export function createWorkflowTemplate(value: unknown): GraphWorkflowTemplate {
  const template = parseWorkflowTemplate(value);
  const path = templatePath(template.template_id);
  if (existsSync(path)) throw new Error(`Workflow template already exists: ${template.template_id}`);
  atomicWrite(path, `${JSON.stringify(template, null, 2)}\n`);
  return template;
}

export function updateWorkflowTemplate(templateId: string, value: unknown): GraphWorkflowTemplate {
  const template = parseWorkflowTemplate(value);
  if (template.template_id !== templateId) throw new Error(`Workflow template id cannot change (${templateId} → ${template.template_id})`);
  const path = templatePath(templateId);
  if (!existsSync(path)) throw new Error(`Workflow template not found: ${templateId}`);
  atomicWrite(path, `${JSON.stringify(template, null, 2)}\n`);
  return template;
}

export function deleteWorkflowTemplate(templateId: string): void {
  const path = templatePath(templateId);
  if (!existsSync(path)) throw new Error(`Workflow template not found: ${templateId}`);
  unlinkSync(path);
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
    if (!node || typeof node !== 'object') throw new Error('Graph node must be an object');
    if (typeof node.node_id !== 'string') throw new Error('Graph node_id must be a string');
    if (!node.node_id.trim()) throw new Error('Graph node_id cannot be empty');
    if (nodeIds.has(node.node_id)) throw new Error(`Duplicate graph node_id: ${node.node_id}`);
    if (typeof node.title !== 'string' || !node.title.trim()) throw new Error(`Graph node has no title: ${node.node_id}`);
    if (!isStringArray(node.assignees)) throw new Error(`Graph node has invalid assignees: ${node.node_id}`);
    if (typeof node.action !== 'string' || !node.action.trim()) throw new Error(`Graph node has no action: ${node.node_id}`);
    if (node.completion !== 'all' && node.completion !== 'any') throw new Error(`Graph node has invalid completion: ${node.node_id}`);
    if (node.gate !== undefined && typeof node.gate !== 'boolean') throw new Error(`Graph node has invalid gate: ${node.node_id}`);
    if (node.context !== undefined) {
      if (!node.context || typeof node.context !== 'object' || Array.isArray(node.context)) {
        throw new Error(`Graph node has invalid context: ${node.node_id}`);
      }
      if (!['resident', 'fresh_per_run', 'fresh_per_activation'].includes(node.context.mode)) {
        throw new Error(`Graph node has invalid context mode: ${node.node_id}`);
      }
    }
    if (node.base_assignees !== undefined && !isStringArray(node.base_assignees)) {
      throw new Error(`Graph node has invalid base_assignees: ${node.node_id}`);
    }
    nodeIds.add(node.node_id);
  }
  if (!nodeIds.has(definition.entry_node_id)) throw new Error(`Entry node not found: ${definition.entry_node_id}`);

  const edgeIds = new Set<string>();
  const conditions = new Set<string>();
  for (const edge of definition.edges) {
    if (!edge || typeof edge !== 'object') throw new Error('Graph edge must be an object');
    if (typeof edge.edge_id !== 'string' || !edge.edge_id.trim()) throw new Error('Graph edge_id cannot be empty');
    if (typeof edge.from !== 'string' || typeof edge.to !== 'string') throw new Error(`Graph edge has invalid endpoints: ${edge.edge_id}`);
    if (!['passed', 'changes_requested', 'failed'].includes(edge.when)) throw new Error(`Graph edge has invalid outcome: ${edge.edge_id}`);
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
