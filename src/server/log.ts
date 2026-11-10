/**
 * The core's log goes to stderr, which the desktop shell forwards to its own
 * log. Prompts, file contents, keys and cookies never belong here.
 */
type Fields = Record<string, unknown> | unknown;

function line(level: string, message: string, fields?: Fields): void {
  const at = new Date().toISOString();
  let extra = "";
  if (fields instanceof Error) extra = ` ${fields.stack ?? fields.message}`;
  else if (fields !== undefined) {
    try {
      extra = ` ${JSON.stringify(fields)}`;
    } catch {
      extra = ` ${String(fields)}`;
    }
  }
  process.stderr.write(`${at} ${level} ${message}${extra}\n`);
}

export const log = {
  info: (message: string, fields?: Fields) => line("info", message, fields),
  warn: (message: string, fields?: Fields) => line("warn", message, fields),
  error: (message: string, fields?: Fields) => line("error", message, fields),
  debug: (message: string, fields?: Fields) => {
    if (process.env.PHAETHON_DEBUG) line("debug", message, fields);
  },
};
