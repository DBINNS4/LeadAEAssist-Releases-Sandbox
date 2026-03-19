const path = require('path');
const { copyFileWithProgress } = require('./fileUtils');

/**
 * Filters out the destination path from the list of source files.
 * Prevents users from accidentally passing the destination as a source.
 *
 * @param {string[]} sourceFiles
 * @param {string} destination
 * @returns {string[]}
 */
function filterOutDestination(sourceFiles = [], destination = '') {
  const resolvedDest = path.resolve(destination);
  return sourceFiles.filter(p => {
    try {
      return path.resolve(p) !== resolvedDest;
    } catch {
      return true;
    }
  });
}

/**
 * Copies an array of source files into the destination directory.
 *
 * @param {string[]} sources
 * @param {string} destination
 * @param {AbortSignal} [signal]
 * @param {function} [progressCb]
 * @returns {Promise<string[]>} Resolves with array of destination file paths
 */
async function copySources(sources = [], destination = '', signal, progressCb = () => {}) {
  const destPaths = [];
  for (const src of sources) {
    const destPath = path.join(destination, path.basename(src));
    await copyFileWithProgress(src, destPath, progressCb, signal);
    destPaths.push(destPath);
  }
  return destPaths;
}

module.exports = { filterOutDestination, copySources };
