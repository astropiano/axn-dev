import type { Command } from "@axn-dev/core";
import { backupDotenvFiles } from "./dotenv-backup.js";
import { backupDotenvToBitwarden } from "./dotenv-bitwarden.js";
import { dotenvCompleter } from "./completion.js";

export class BackupCommand implements Command {
  readonly name = "backup";
  readonly description = "Back up dotenv files";

  complete = dotenvCompleter([
    "--infra", "-i", "--scenario", "-s", "--base", "--to",
    "--tar", "--bitwarden", "--force", "--help", "-h",
  ]);

  help(): string {
    return `
axn-dev backup dotenv [options]

Back up .env files for infra and/or scenarios.

Options:
  --infra, -i <pattern> Infra target pattern. Use * for all .env files under the infra root.
  --scenario, -s <name> Scenario name to back up. Use * for all scenarios.
  --base <dir>          Base directory for relative storage. Defaults to ~.
  --to <path>           Output path. Defaults to ~/.axn-dev/dotenv-backups/dotenv-backup
  --tar                 Output as a tar archive instead of a directory.
  --bitwarden           Store each .env as a YAML secure note in axn-dev-infra or axn-dev-scenarios.
  --force               Overwrite existing Bitwarden notes (only with --bitwarden).
  -h, --help            Show this help

Examples:
  axn-dev backup dotenv --infra *
  axn-dev backup dotenv -s dev
  axn-dev backup dotenv --infra * --base ~/repos --tar --to mybackup.tar
  axn-dev backup dotenv --infra * --bitwarden
  axn-dev backup dotenv --bitwarden -s dev --force
`;
  }

  async execute(args: string[]): Promise<void> {
    if (!args.length || args[0] === "--help" || args[0] === "-h") {
      console.log(this.help());
      return;
    }

    if (args[0] !== "dotenv") {
      throw new Error(`Unknown backup subcommand '${args[0]}'. Run 'axn-dev backup --help'.`);
    }

    const dotenvArgs = args.slice(1);
    const options: Parameters<typeof backupDotenvFiles>[0] = {};
    const bwOptions: Parameters<typeof backupDotenvToBitwarden>[0] = {};
    let useBitwarden = false;

    for (let i = 0; i < dotenvArgs.length; i++) {
      const a = dotenvArgs[i];
      if (a === "--help" || a === "-h") {
        console.log(this.help());
        return;
      } else if (a === "--infra" || a === "-i") {
        options.infra = dotenvArgs[++i];
        bwOptions.infra = dotenvArgs[i];
      } else if (a === "--scenario" || a === "-s") {
        options.scenario = dotenvArgs[++i];
        bwOptions.scenario = dotenvArgs[i];
      } else if (a === "--base") {
        options.base = dotenvArgs[++i];
      } else if (a === "--to") {
        options.to = dotenvArgs[++i];
      } else if (a === "--tar") {
        options.tar = true;
      } else if (a === "--bitwarden") {
        useBitwarden = true;
      } else if (a === "--force") {
        bwOptions.force = true;
      } else {
        throw new Error(`Unknown option: ${a}. Run 'axn-dev backup dotenv --help'.`);
      }
    }

    if (!options.infra && !options.scenario) {
      throw new Error("Nothing to back up. Use --infra <pattern> or -s <scenario>.");
    }

    if (useBitwarden) {
      const backedUp = await backupDotenvToBitwarden(bwOptions);
      if (backedUp.length === 0) {
        console.log("\nNo .env files were backed up (all already exist in Bitwarden). Use --force to overwrite.");
        return;
      }
      console.log(`\nBacked up ${backedUp.length} .env file(s) to Bitwarden:`);
      for (const { folder, name } of backedUp) console.log(`  ${folder}/${name}`);
      return;
    }

    const to = await backupDotenvFiles(options);
    console.log(`\nBacked up dotenv files to: ${to}`);
  }
}
