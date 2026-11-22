import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDriveItServer } from "./app.js";

const { server } = createDriveItServer();
await server.connect(new StdioServerTransport());
