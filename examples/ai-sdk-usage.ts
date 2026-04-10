// @ts-nocheck
import { createDocsVFSTool } from "docsvfs/tool";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

// Give any AI agent a bash shell over your docs — 3 lines
const docsTool = await createDocsVFSTool({ rootDir: "./docs" });

const { text } = await generateText({
  model: openai("gpt-4o"),
  tools: { docs: docsTool },
  prompt: "What authentication methods does this API support?",
});
