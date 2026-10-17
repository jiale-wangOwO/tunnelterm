#!/usr/bin/env node
import {runMcpServer} from '../src/mcp-server.mjs';

runMcpServer().catch(error => {
  console.error(`TunnelTerm MCP: ${error.message}`);
  process.exitCode = 1;
});
