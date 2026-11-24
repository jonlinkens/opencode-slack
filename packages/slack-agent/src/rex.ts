import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const executeFile = promisify(execFile);
const rexSessionSchema = z.object({ session_id: z.string() });

export async function openSessionInRex(input: {
  label: string;
  directory: string;
  sessionID: string;
  shouldFocus: boolean;
}) {
  const { stdout } = await executeFile("rex", [
    "new",
    input.label,
    "--json",
    "-c",
    input.directory,
    "--",
    "opencode",
    "--session",
    input.sessionID,
  ]);
  const { session_id } = rexSessionSchema.parse(JSON.parse(stdout));
  if (input.shouldFocus) {
    await executeFile("rex", ["do", "session.select", `session_id=${session_id}`]);
  }
  return session_id;
}
