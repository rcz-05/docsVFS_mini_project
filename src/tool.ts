/**
 * tool.ts — Vercel AI SDK tool export for DocsVFS.
 *
 * Use this to give any AI agent (Claude, GPT, etc.) a bash shell
 * over your documentation, using the AI SDK's tool interface.
 *
 * @example
 * ```ts
 * import { createDocsVFSTool } from "docsvfs/tool";
 *
 * const docsTool = await createDocsVFSTool({ rootDir: "./docs" });
 *
 * // Use with Vercel AI SDK
 * const result = await generateText({
 *   model: openai("gpt-4o"),
 *   tools: { docs: docsTool },
 *   prompt: "Find all files about authentication in the docs",
 * });
 * ```
 */

import { createDocsVFS, type DocsVFSOptions } from "./create.js";

export interface DocsVFSTool {
  description: string;
  parameters: {
    type: "object";
    properties: {
      command: {
        type: "string";
        description: string;
      };
    };
    required: string[];
  };
  execute: (args: { command: string }) => Promise<string>;
}

/**
 * Create a Vercel AI SDK compatible tool that gives agents
 * a bash shell over your documentation.
 */
export async function createDocsVFSTool(
  options: DocsVFSOptions
): Promise<DocsVFSTool> {
  const vfs = await createDocsVFS(options);

  return {
    description:
      `A read-only bash shell over a documentation folder (${vfs.stats.fileCount} files). ` +
      `Use standard Unix commands: ls, cd, tree, find, grep -r, cat. ` +
      `The filesystem is read-only (writes will fail with EROFS). ` +
      `Start with 'tree / -L 2' to see the structure, then grep/cat to explore.`,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "A bash command to execute in the virtual docs filesystem. " +
            "Supports: ls, cd, cat, grep, find, tree, head, tail, wc, sort, etc.",
        },
      },
      required: ["command"],
    },
    execute: async ({ command }) => {
      try {
        const result = await vfs.exec(command);
        let output = "";
        if (result.stdout) output += result.stdout;
        if (result.stderr) output += (output ? "\n" : "") + `stderr: ${result.stderr}`;
        if (result.exitCode !== 0 && !output) {
          output = `Command exited with code ${result.exitCode}`;
        }
        return output || "(no output)";
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
  };
}

export type { DocsVFSOptions };
