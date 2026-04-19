/**
 * remember-tool.ts — Vercel AI SDK tool for pinning notes into /memory.
 *
 * Pairs with `createDocsVFSTool`. Where the docs tool lets an agent *read*
 * the corpus, `remember` lets it durably *commit* a finding to the writable
 * /memory mount — with a distinct provenance tag (`source: "tool"`) so the
 * janitor can later reason about which notes came from deliberate tool
 * calls vs. raw bash writes.
 *
 * Why a dedicated tool when the agent could `echo >> /memory/…` via bash?
 * Two reasons: (1) structured writes are easier for the model to use
 * correctly — no quoting/escaping tax; (2) the `source: "tool"` provenance
 * gives the janitor a higher-confidence signal than untagged agent writes.
 *
 * @example
 * ```ts
 * import { createDocsVFS } from "docsvfs";
 * import { createDocsVFSTool } from "docsvfs/tool";
 * import { createRememberTool } from "docsvfs/remember";
 *
 * const vfs = await createDocsVFS({ rootDir: "./docs", memory: true });
 * const docs = await createDocsVFSTool({ ...shared options...});
 * const remember = createRememberTool({ vfs });
 *
 * await generateText({
 *   model: openai("gpt-4o"),
 *   tools: { docs, remember },
 *   prompt: "Explore the docs and pin a summary of the Slurm setup.",
 * });
 * ```
 */

import type { DocsVFSInstance } from "./create.js";
import type { WritableFileSystem } from "./memory/writable-fs.js";

export interface RememberToolOptions {
  /**
   * A DocsVFS instance with memory enabled. Must have been created via
   * `createDocsVFS({ memory: true, ... })`.
   */
  vfs: DocsVFSInstance;
  /**
   * Mount to write into (default "/memory"). Must be a writable mount
   * registered on the vfs.
   */
  mount?: string;
}

export interface RememberArgs {
  /** Human-readable topic; slugified into a filename. */
  topic: string;
  /** Markdown content to store. */
  content: string;
  /** When true, append to any existing note; otherwise overwrite. */
  append?: boolean;
  /** Optional free-form note recorded in provenance. */
  note?: string;
}

export interface RememberResult {
  ok: true;
  path: string;
  bytes: number;
  mode: "overwrite" | "append";
}

export interface RememberTool {
  description: string;
  parameters: {
    type: "object";
    properties: {
      topic: { type: "string"; description: string };
      content: { type: "string"; description: string };
      append: { type: "boolean"; description: string };
      note: { type: "string"; description: string };
    };
    required: string[];
  };
  execute: (args: RememberArgs) => Promise<RememberResult>;
}

const MAX_SLUG_LEN = 60;

/**
 * Slugify a topic into a filesystem-safe basename (without extension).
 * Lowercases, maps any run of non-[a-z0-9] to `-`, trims dashes, and
 * caps length. Empty results fall back to "note".
 */
export function slugifyTopic(topic: string): string {
  const slug = topic
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, "");
  return slug || "note";
}

/**
 * Build a Vercel AI SDK-compatible `remember` tool bound to a DocsVFS
 * instance with memory enabled.
 */
export function createRememberTool(options: RememberToolOptions): RememberTool {
  const { vfs } = options;
  const mount = options.mount ?? "/memory";

  if (!vfs.memory) {
    throw new Error(
      "createRememberTool: vfs was created without `memory: true`. Enable memory in createDocsVFS."
    );
  }

  const entry = vfs.memory.mounts.find((m) => m.mountPoint === mount);
  if (!entry) {
    throw new Error(
      `createRememberTool: mount "${mount}" not registered on this vfs. Available: ${vfs.memory.mounts.map((m) => m.mountPoint).join(", ")}`
    );
  }
  const wfs: WritableFileSystem = entry.filesystem;

  return {
    description:
      "Pin a durable note into /memory. Topic is slugified into a filename, " +
      "content is written as markdown. Overwrites an existing note by default; " +
      "set `append: true` to append instead. Writes are tagged with provenance " +
      'source="tool" so they can be audited later.',
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Short human-readable topic; becomes the filename slug.",
        },
        content: {
          type: "string",
          description: "Markdown content of the note.",
        },
        append: {
          type: "boolean",
          description:
            "When true, append to an existing note. Default false (overwrite).",
        },
        note: {
          type: "string",
          description:
            "Optional free-form note recorded alongside provenance (e.g. the source query).",
        },
      },
      required: ["topic", "content"],
    },
    execute: async (args: RememberArgs): Promise<RememberResult> => {
      const slug = slugifyTopic(args.topic);
      const relPath = `/${slug}.md`;
      const fullPath = `${mount}${relPath}`;
      const mode: "overwrite" | "append" = args.append ? "append" : "overwrite";

      if (mode === "append") {
        await wfs.appendFileAs(relPath, args.content, "tool", args.note);
      } else {
        await wfs.writeFileAs(relPath, args.content, "tool", args.note);
      }

      const buf = await wfs.readFileBuffer(relPath);
      return {
        ok: true,
        path: fullPath,
        bytes: buf.byteLength,
        mode,
      };
    },
  };
}
