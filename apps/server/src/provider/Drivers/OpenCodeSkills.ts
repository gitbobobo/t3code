/**
 * OpenCodeSkills — filesystem discovery of OpenCode/Agent skills for the `/`
 * and `$` pickers.
 *
 * OpenCode loads skills from user and project Agent Skills directories, one
 * directory per skill with a `SKILL.md` carrying YAML frontmatter. The
 * `opencode serve` inventory does not surface these as provider snapshot
 * fields, so discovery scans the filesystem directly (mirroring CursorSkills).
 *
 * Normal skills appear in both `slashCommands` and `skills`. Skills with
 * `disable-model-invocation: true` appear only in `slashCommands`.
 *
 * @module provider/Drivers/OpenCodeSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverSkillsFromRoots, type SkillFilesystemRoot } from "./SkillFilesystem.ts";

export type OpenCodeSkillsDiscovery = {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
};

function resolveUserHomeDir(environment: NodeJS.ProcessEnv): string {
  const homeFromEnv = environment.HOME?.trim() ?? "";
  return homeFromEnv.length > 0 ? homeFromEnv : NodeOS.homedir();
}

/**
 * Resolve the optional OpenCode custom config directory from
 * `OPENCODE_CONFIG_DIR` (relative values resolved against cwd, matching the
 * CLI). OpenCode loads this directory after the global and project
 * directories, so it is scanned last and wins name collisions. Returns
 * `undefined` when the variable is unset.
 */
const resolveOpenCodeConfigDirPath = Effect.fn("resolveOpenCodeConfigDirPath")(function* (
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string | undefined, never, Path.Path> {
  const path = yield* Path.Path;
  // No tilde expansion: the env var is received verbatim by the CLI, so a
  // literal `~` must stay literal for discovery to scan the same directory.
  const environmentConfigDir = environment.OPENCODE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length === 0) {
    return undefined;
  }
  return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
});

/**
 * Enumerate OpenCode/Agent skills from user and project skill roots.
 * Discovery is best-effort: unreadable roots and malformed skill entries are
 * skipped. On name collisions later roots overwrite earlier ones:
 * `OPENCODE_CONFIG_DIR` > project > user; within the same scope
 * `.opencode` > `.agents`.
 */
export const discoverOpenCodeSkills = Effect.fn("discoverOpenCodeSkills")(function* (
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<OpenCodeSkillsDiscovery, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const resolvedEnvironment = environment ?? process.env;
  const openCodeConfigDirPath = yield* resolveOpenCodeConfigDirPath(resolvedEnvironment, cwd);
  const homeDir = resolveUserHomeDir(resolvedEnvironment);

  const roots: ReadonlyArray<SkillFilesystemRoot> = [
    { directory: path.join(homeDir, ".agents", "skills"), scope: "user" },
    { directory: path.join(homeDir, ".config", "opencode", "skills"), scope: "user" },
    ...(cwd
      ? [
          { directory: path.join(cwd, ".agents", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".opencode", "skills"), scope: "project" as const },
        ]
      : []),
    ...(openCodeConfigDirPath
      ? [{ directory: path.join(openCodeConfigDirPath, "skills"), scope: "user" as const }]
      : []),
  ];

  const discovered = yield* discoverSkillsFromRoots(roots);

  const slashCommands: ReadonlyArray<ServerProviderSlashCommand> = discovered.map((skill) => ({
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
  }));

  const skills: ReadonlyArray<ServerProviderSkill> = discovered
    .filter((skill) => !skill.disableModelInvocation)
    .map((skill) => ({
      name: skill.name,
      path: skill.path,
      enabled: true,
      scope: skill.scope,
      ...(skill.description ? { description: skill.description } : {}),
    }));

  return { skills, slashCommands };
});
