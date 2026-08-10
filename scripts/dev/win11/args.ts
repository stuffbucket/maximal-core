/**
 * Command-line parsing. Small, explicit, and separate so it can be tested
 * without a hypervisor: the `--` passthrough in particular is easy to get
 * subtly wrong, and `winvm exec -- <cmd>` depends on it entirely.
 */
export interface Args {
  readonly flags: ReadonlyMap<string, string>
  readonly positional: readonly string[]
  /** Everything after `--`, verbatim, so guest commands keep their own flags. */
  readonly rest: readonly string[]
}

export function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>()
  const positional: string[] = []
  const rest: string[] = []
  let afterDoubleDash = false

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === undefined) continue
    if (afterDoubleDash) {
      rest.push(a)
      continue
    }
    if (a === "--") {
      afterDoubleDash = true
      continue
    }
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      // A flag followed by a non-flag consumes it as a value; otherwise it is
      // boolean. `--ephemeral` and `--image foo` therefore both work.
      if (next !== undefined && !next.startsWith("-")) {
        flags.set(key, next)
        i += 1
      } else {
        flags.set(key, "true")
      }
      continue
    }
    if (a === "-i") {
      const next = argv[i + 1]
      if (next !== undefined) {
        flags.set("instance", next)
        i += 1
      }
      continue
    }
    positional.push(a)
  }
  return { flags, positional, rest }
}

/** Instance selection: `-i`, else WINVM_INSTANCE, else "default". */
export function instanceName(args: Args): string {
  return args.flags.get("instance") ?? process.env["WINVM_INSTANCE"] ?? "default"
}

/** Image selection: `--image`, else WINVM_IMAGE, else the conventional name. */
export function imageName(args: Args): string {
  return args.flags.get("image") ?? process.env["WINVM_IMAGE"] ?? "win11-arm64"
}
