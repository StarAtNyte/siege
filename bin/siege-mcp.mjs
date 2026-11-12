#!/usr/bin/env node
// siege-mcp: the SIEGE MCP server over stdio. Configuration is by environment variable; see src/mcp/server.ts.
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/mcp/server.ts");
await main();
