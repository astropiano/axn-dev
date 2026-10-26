export interface CommandExecuteOptions {
  env?: Record<string, string>;
  /** Quiet mode — suppress routine progress output (CI). Errors still print. */
  quiet?: boolean;
  /** Collect subprocess output (e.g. compose logs) — e.g. to replay on failure. */
  onOutput?: (chunk: string) => void;
}

export interface Command {
  readonly name: string;
  readonly description: string;
  execute(args: string[], options?: CommandExecuteOptions): Promise<void>;
  help(): string;
  /**
   * Optional shell tab-completion contribution.
   * `words` is the full command line split by spaces, starting from
   * words[0] = "axn-dev", words[1] = this command's name.
   * Return the candidate completions for the last word.
   */
  complete?(words: string[]): string[] | Promise<string[]>;
}

/** Shared completer: filter a static flag list by the current word prefix. */
export function flagCompleter(flags: string[]) {
  return (words: string[]): string[] => {
    const cur = words[words.length - 1] ?? "";
    return flags.filter((f) => f.startsWith(cur) && f !== cur);
  };
}
