#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CommandRegistry,
  StartCommand,
  StopCommand,
  ListCommand,
  CleanCommand,
  PatchCommand,
  GitCommand,
  discoverPlugins,
  pluginCommands,
  pluginScenarioDrivers,
  pluginFlowAdapters,
  pluginFlowJudges,
  pluginDeviceEnvResolvers,
  registerScenarioDriver,
  registerFlowAdapter,
  registerFlowJudge,
  registerDeviceEnvResolver,
} from "@axn-dev/core";
import { InitCommand } from "./commands/init.js";
import { SetupCommand } from "./commands/setup.js";
import { InstallCommand } from "./commands/install.js";
import { UninstallCommand } from "./commands/uninstall.js";
import { CompletionCommand } from "./commands/completion.js";
import { complete } from "./completion.js";

const registry = new CommandRegistry();

// Built-in core + meta commands
registry.register(new StartCommand());
registry.register(new StopCommand());
registry.register(new ListCommand());
registry.register(new CleanCommand());
registry.register(new PatchCommand());
registry.register(new GitCommand());
registry.register(new InitCommand());
registry.register(new SetupCommand());
registry.register(new InstallCommand());
registry.register(new UninstallCommand());
registry.register(new CompletionCommand());

// Plugin commands (lazy: manifest gives name/description, module loads on dispatch).
// Scan roots: AXN_DEV_PLUGIN_DIRS + ~/.axn-dev/plugins/node_modules (in core),
// plus the directory containing this package — that makes workspace siblings
// and npm-installed sibling packages work with zero configuration.
const cliPackageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const plugins = discoverPlugins([join(cliPackageDir, "..")]);
for (const pkg of plugins) {
  // Scenario types contributed by the plugin — markers register now so
  // scenario discovery resolves types without importing driver modules.
  for (const spec of pluginScenarioDrivers(pkg)) {
    registerScenarioDriver(spec);
  }
  // Flow adapters — tags/names register now so step dispatch routes without
  // importing adapter modules.
  for (const spec of pluginFlowAdapters(pkg)) {
    registerFlowAdapter(spec);
  }
  // Flow judges — names register now, judge modules load on first judge="name".
  for (const spec of pluginFlowJudges(pkg)) {
    registerFlowJudge(spec);
  }
  // Device-env resolvers — specs register now, module loads on first -i use.
  for (const spec of pluginDeviceEnvResolvers(pkg)) {
    registerDeviceEnvResolver(spec);
  }
  for (const cmd of pluginCommands(pkg)) {
    if (registry.get(cmd.name)) {
      console.error(`Warning: plugin ${pkg.name} command '${cmd.name}' conflicts with a built-in command — skipping.`);
      continue;
    }
    registry.register(cmd);
  }
}

// Handle tab-completion requests from shell hook
if (process.argv[2] === "--complete") {
  const words = process.argv.slice(3);
  const completions = await complete(words, registry);
  process.stdout.write(completions.join("\n") + (completions.length ? "\n" : ""));
  process.exit(0);
}

const [commandName, ...rest] = process.argv.slice(2);

if (!commandName || commandName === "--help" || commandName === "-h") {
  console.log(`
axn-dev — modular development CLI (repos, scenarios, plugins)

Usage:
  axn-dev <command> [options]

Commands:
${registry.helpText()}

Run 'axn-dev <command> --help' for command-specific help.
`);
  process.exit(commandName ? 0 : 1);
}

const command = await registry.resolve(commandName);
if (!command) {
  console.error(`Unknown command: ${commandName}`);
  console.error(`Run 'axn-dev --help' for available commands.`);
  process.exit(1);
}

try {
  await command.execute(rest);
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
