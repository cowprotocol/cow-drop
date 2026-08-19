/**
 * The logger both CLIs use.
 *
 * Deliberately a console wrapper and nothing more: these are two operator-facing processes whose
 * whole output is read by a human in a terminal or scraped out of `journalctl`. A logging framework
 * would buy structured sinks and log levels nobody configures, at the cost of a dependency in the
 * path of the one thing an operator needs to see — that the process came up.
 */
export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Logs nothing. The library default, so embedding a watch tower is silent unless asked otherwise. */
export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

export interface LoggerOptions {
  /** Which process is speaking — `keeper`, `watch-tower`. Prefixed onto every line. */
  name: string
  /**
   * Which chain this process is bound to. Prefixed onto every line alongside the name.
   *
   * A process handles exactly one chain, so this belongs in the prefix rather than in each message:
   * the lines an operator reads are otherwise identical across an Ethereum and a Gnosis keeper, and
   * addresses do not distinguish them — the same drop can exist on both.
   */
  chainId?: number
  /** Errors only. */
  quiet?: boolean
}

/**
 * `HH:MM:SS level name[chain]  message`, one line per event, UTC.
 *
 * UTC rather than local: the two services are compared against block timestamps and against each
 * other's logs across machines, and a local-time stamp makes that arithmetic wrong in a way that is
 * invisible until it matters.
 *
 * Errors go to stderr and ignore `quiet`, so a crashing process still says why under `--quiet`.
 */
export function createLogger({ name, chainId, quiet = false }: LoggerOptions): Logger {
  const source = chainId === undefined ? name : `${name}[${chainId}]`
  /** One formatted line, before any decision about where it goes. */
  const line = (level: string, message: string) =>
    `${new Date().toISOString().slice(11, 19)} ${level.padEnd(5)} ${source}  ${message}`

  return {
    info: (message) => {
      if (!quiet) console.log(line('info', message))
    },
    warn: (message) => {
      if (!quiet) console.warn(line('warn', message))
    },
    error: (message) => console.error(line('error', message)),
  }
}
