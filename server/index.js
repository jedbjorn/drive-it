import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDriveItServer } from "./app.js";

const { server, references } = createDriveItServer();

// Normal shutdown removes this session's unretained reference images. The client may close stdin,
// close the transport, or signal; "exit" covers a natural exit. A hard kill leaves them for the
// next startup's stale-session sweep.
function shutdown(exitCode) {
  references.closeSync();
  if (exitCode !== undefined) process.exit(exitCode);
}
process.stdin.once("end", () => shutdown());
process.stdin.once("close", () => shutdown());
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.once(signal, () => shutdown(0));
}
process.once("exit", () => shutdown());

server.server.onclose = () => shutdown();
await server.connect(new StdioServerTransport());
references.cleanupStaleSessions().catch(error => {
  console.error(`drive-it: stale reference-image cleanup failed: ${error.message}`);
});
