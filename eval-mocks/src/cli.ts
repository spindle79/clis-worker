#!/usr/bin/env node
// Entrypoint for the mock-cli dispatcher. Symlinked under each CLI's
// name (e.g. eval-mocks/bin/slack-pp-cli → ../dist/eval-mocks/src/cli.js)
// so the worker's Bash tool resolves CLI names to this script.
//
// argv[0]   = node
// argv[1]   = absolute path of the symlink that was invoked
// argv[2..] = the CLI's own arguments
//
// We resolve argv[1]'s basename to determine which CLI we're impersonating.

import path from "node:path";
import { dispatch } from "./dispatcher.js";

async function main(): Promise<number> {
  const invokedAs = process.argv[1] ?? "";
  const cli = path.basename(invokedAs);
  if (!cli) {
    process.stderr.write("eval-mocks/cli: cannot determine CLI name\n");
    return 2;
  }

  const argv = process.argv.slice(2);

  // Read all of stdin synchronously if any was piped. Agent commands
  // usually don't pipe; the slack POST workaround does.
  let stdin = "";
  if (!process.stdin.isTTY) {
    stdin = await readStdin();
  }

  return dispatch({
    cli,
    argv,
    stdin,
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write(`eval-mocks/cli: unexpected error: ${err?.stack ?? err}\n`);
  process.exit(1);
});
