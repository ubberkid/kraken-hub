/**
 * The entry point of the standalone single-executable build.
 *
 * `cli.js` decides whether to run itself by comparing `import.meta.url` against
 * `process.argv[1]` — the ESM way to ask "was I run, or imported?". Inside a SEA
 * there is no module URL and no script on argv[1], so that question has no
 * answer and the guard is defined away at bundle time. This file supplies the
 * missing half: it exists only to call `main()` unconditionally.
 */

import { main } from './cli.js';

main().then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (cause: unknown) => {
    process.stderr.write(`${String(cause)}\n`);
    process.exitCode = 1;
  },
);
