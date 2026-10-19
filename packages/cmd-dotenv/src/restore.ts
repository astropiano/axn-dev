import type { Command } from "@axn-dev/core";
import { restoreDotenvFiles } from "./dotenv-backup.js";
import { restoreDotenvFromBitwarden } from "./dotenv-bitwarden.js";
import { dotenvCompleter } from "./completion.js";

export class RestoreCommand implements Command {
  readonly name = "restore";
  readonly description = "Restore dotenv files";

  complete = dotenvCompleter([
    "--from", "-f", "--base", "--force", "--bitwarden",
    "--infra", "-i", "--scenario", "-s", "--help", "-h",
  ]);

  help(): string {
    return `
axn-dev restore dotenv [options]

Restore .env files from a backup directory, tar archive, or Bitwarden.

Options:
  --from, -f <path>   Backup directory or tar file. Defaults to ~/.axn-dev/dotenv-backups/dotenv-backup.tar
  --base <dir>        Base directory to restore into. Defaults to ~.
  --force             Overwrite existing .env files.
  --bitwarden         Restore .env files from Bitwarden instead of a local backup.
  --infra, -i <pat>   Bitwarden restore pattern (requires --bitwarden).
  --scenario, -s <n>  Bitwarden scenario to restore. Use * for all (requires --bitwarden).
  -h, --help          Show this help

Examples:
  axn-dev restore dotenv
  axn-dev restore dotenv --from mybackup.tar --base ~/repos
  axn-dev restore dotenv --from dotenv-backup --force
  axn-dev restore dotenv --bitwarden --infra *
  axn-dev restore dotenv --bitwarden -s dev --force
`;
  }

  async execute(args: string[]): Promise<void> {
    if (!args.length || args[0] === "--help" || args[0] === "-h") {
      console.log(this.help());
      return;
    }

    if (args[0] !== "dotenv") {
      throw new Error(`Unknown restore subcommand '${args[0]}'. Run 'axn-dev restore --help'.`);
    }

    const dotenvArgs = args.slice(1);
    const options: Parameters<typeof restoreDotenvFiles>[0] = {};
    const bwOptions: Parameters<typeof restoreDotenvFromBitwarden>[0] = {};
    let useBitwarden = false;

    for (let i = 0; i < dotenvArgs.length; i++) {
      const a = dotenvArgs[i];
      if (a === "--help" || a === "-h") {
        console.log(this.help());
        return;
      } else if (a === "--from" || a === "-f") {
        options.from = dotenvArgs[++i];
      } else if (a === "--base") {
        options.base = dotenvArgs[++i];
      } else if (a === "--force") {
        options.force = true;
        bwOptions.force = true;
      } else if (a === "--bitwarden") {
        useBitwarden = true;
      } else if (a === "--infra" || a === "-i") {
        bwOptions.infra = dotenvArgs[++i];
      } else if (a === "--scenario" || a === "-s") {
        bwOptions.scenario = dotenvArgs[++i];
      } else {
        throw new Error(`Unknown option: ${a}. Run 'axn-dev restore dotenv --help'.`);
      }
    }

    if (useBitwarden) {
      if (!bwOptions.infra && !bwOptions.scenario) {
        throw new Error("Bitwarden restore requires --infra <pattern> or -s <scenario>.");
      }
      const restored = await restoreDotenvFromBitwarden(bwOptions);
      console.log(`\nRestored ${restored.length} .env file(s):`);
      for (const p of restored) console.log(`  ${p}`);
      return;
    }

    const restored = await restoreDotenvFiles(options);
    console.log(`\nRestored ${restored.length} .env file(s):`);
    for (const p of restored) console.log(`  ${p}`);
  }
}
