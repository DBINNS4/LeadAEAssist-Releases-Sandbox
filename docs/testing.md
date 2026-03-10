# Testing Workflow

This project uses two test runners:

- **Jest** for browser/renderer-oriented suites (`npm run test:jest`).
- **Node's built-in test runner** for Node-only suites that import `node:test` (`npm run test:node`).

## Commands

- `npm run test:jest` runs only Jest suites.
- `npm run test:node` runs only Node-runner suites discovered by `scripts/run-node-tests.js`.
- `npm test` runs both sequentially (`test:jest` then `test:node`).

## Discovery details

- `scripts/run-node-tests.js` recursively scans `test` and `services/entitlement-service/test` for files containing `node:test`, then executes them via `node --test`.
- `package.json` Jest `testPathIgnorePatterns` excludes Node-runner suites (including `test/**/*.node.test.js` and known runtime-asset Node suites) so those files are not executed by Jest.
