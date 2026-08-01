/**
 * One error type for everything that means "this input is not a lockfile we can trust".
 *
 * It exists so the CLI can exit nonzero with a message instead of producing an empty diff.
 * A malformed lockfile that yields "0 changes" is the single worst outcome for this tool,
 * because a reviewer reads "no changes" and approves.
 */
export class LockfileError extends Error {
  constructor(message, { file = null, line = null } = {}) {
    const where = file ? `${file}${line ? `:${line}` : ''}: ` : '';
    super(where + message);
    this.name = 'LockfileError';
    this.file = file;
    this.line = line;
  }
}
