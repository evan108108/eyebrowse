import type { AXNode } from "./types";
import { AX_TREE_MAX_DEPTH, AX_TREE_MAX_CHARS } from "./types";

const SKIP_ROLES = new Set([
  "none",
  "presentation",
  "generic",
  "InlineTextBox",
  "StaticText",
]);

interface FormattedNode {
  role: string;
  name: string;
  value: string;
  props: string[];
  depth: number;
  children: FormattedNode[];
}

/** Convert CDP flat AXNode array to indented ARIA snapshot text */
export function formatAXTree(nodes: AXNode[]): string {
  if (!nodes || nodes.length === 0) return "(empty accessibility tree)";

  // Build node map
  const nodeMap = new Map<string, AXNode>();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
  }

  // Find root(s) — nodes with no parent
  const rootIds: string[] = [];
  for (const node of nodes) {
    if (!node.parentId) rootIds.push(node.nodeId);
  }

  // Recursive formatter
  function formatNode(nodeId: string, depth: number): string[] {
    if (depth > AX_TREE_MAX_DEPTH) return [];

    const node = nodeMap.get(nodeId);
    if (!node) return [];
    if (node.ignored) return [];

    const role = node.role?.value ?? "";
    if (SKIP_ROLES.has(role)) {
      // Still process children even if this node is skipped
      return (node.childIds ?? []).flatMap((cid) => formatNode(cid, depth));
    }

    const name = node.name?.value ?? "";
    let value = node.value?.value ?? "";

    // Password redaction
    const inputType = node.properties?.find((p) => p.name === "inputType");
    if (inputType?.value?.value === "password") {
      value = "[REDACTED]";
    }

    // Collect key properties
    const props: string[] = [];
    for (const prop of node.properties ?? []) {
      switch (prop.name) {
        case "focused":
          if (prop.value.value) props.push("focused");
          break;
        case "disabled":
          if (prop.value.value) props.push("disabled");
          break;
        case "checked":
          if (prop.value.value === "true" || prop.value.value === true) props.push("checked");
          else if (prop.value.value === "mixed") props.push("mixed");
          break;
        case "expanded":
          if (prop.value.value === true) props.push("expanded");
          else if (prop.value.value === false) props.push("collapsed");
          break;
        case "level":
          if (prop.value.value) props.push(`level=${prop.value.value}`);
          break;
        case "required":
          if (prop.value.value) props.push("required");
          break;
        case "selected":
          if (prop.value.value) props.push("selected");
          break;
      }
    }

    // Format this node
    const indent = "  ".repeat(depth);
    let line = `${indent}${role}`;
    if (name) line += ` "${name}"`;
    if (value) line += ` value="${value}"`;
    if (props.length > 0) line += ` [${props.join(", ")}]`;

    const lines = [line];

    // Process children
    for (const childId of node.childIds ?? []) {
      lines.push(...formatNode(childId, depth + 1));
    }

    return lines;
  }

  // Build the tree from roots
  const allLines: string[] = [];
  for (const rootId of rootIds) {
    allLines.push(...formatNode(rootId, 0));
  }

  // Truncate at max chars
  let result = "";
  for (const line of allLines) {
    if (result.length + line.length + 1 > AX_TREE_MAX_CHARS) {
      result += "\n... (truncated)";
      break;
    }
    if (result) result += "\n";
    result += line;
  }

  return result || "(empty accessibility tree)";
}
