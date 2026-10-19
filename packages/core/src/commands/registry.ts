import type { Command } from "./command.js";
import { LazyCommand } from "../plugin.js";

export class CommandRegistry {
  private commands = new Map<string, Command>();

  register(command: Command): void {
    this.commands.set(command.name, command);
  }

  get(name: string): Command | undefined {
    return this.commands.get(name);
  }

  names(): string[] {
    return [...this.commands.keys()];
  }

  entries(): Command[] {
    return [...this.commands.values()];
  }

  /** Get a command, loading it first if it is a lazily-registered plugin command. */
  async resolve(name: string): Promise<Command | undefined> {
    const cmd = this.commands.get(name);
    if (!cmd) return undefined;
    return cmd instanceof LazyCommand ? cmd.load() : cmd;
  }

  helpText(): string {
    return [...this.commands.values()]
      .map((cmd) => `  ${cmd.name.padEnd(12)} ${cmd.description}`)
      .join("\n");
  }
}
