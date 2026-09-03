#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp-tools.js";
import { OUTPUT_DIR } from "./paths.js";

// When set (e.g. http://localhost:3030), scenes live in the long-lived relay for
// live viewing and co-editing. Unset = file-only mode (each scene is a file).
// (The relay also serves MCP directly over HTTP at /mcp — this stdio entrypoint
// is for running the server on the host instead, or pure file-mode with no relay.)
const RELAY_URL = process.env.EXCALIDRAW_RELAY_URL;

async function main() {
  const server = createServer(RELAY_URL);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is the MCP transport.
  console.error(
    RELAY_URL
      ? `excalidraw-mcp ready. Relay: ${RELAY_URL.replace(/\/+$/, "")} (output dir: ${OUTPUT_DIR})`
      : `excalidraw-mcp ready. Output dir: ${OUTPUT_DIR}`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
