/**
 * CursorSkills — filesystem discovery of Cursor/Agent skills for the `/` and
 * `$` pickers.
 *
 * Cursor loads skills from user and project Agent Skills directories, one
 * directory per skill with a `SKILL.md` carrying YAML frontmatter. The ACP
 * handshake does not surface these as provider snapshot fields, so discovery
 * scans the filesystem directly (mirroring ClaudeSkills).
 *
 * Normal skills appear in both `slashCommands` and `skills`. Skills with
 * `disable-model-invocation: true` appear only in `slashCommands`.
 *
 * @module provider/Drivers/CursorSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverSkillsFromRoots, type SkillFilesystemRoot } from "./SkillFilesystem.ts";

export type CursorSkillsDiscovery = {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
};

function resolveUserHomeDir(environment: NodeJS.ProcessEnv): string {
  const homeFromEnv = environment.HOME?.trim() ?? "";
  return homeFromEnv.length > 0 ? homeFromEnv : NodeOS.homedir();
}

/**
 * Resolve the Cursor config directory: `CURSOR_CONFIG_DIR` from the process
 * environment when set (relative values resolved against cwd, matching Claude's
 * `CLAUDE_CONFIG_DIR` handling), otherwise `~/.cursor`.
 */
const resolveCursorConfigDirPath = Effect.fn("resolveCursorConfigDirPath")(function* (
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  // No tilde expansion: the env var is received verbatim by the CLI, so a
  // literal `~` must stay literal for discovery to scan the same directory.
  const environmentConfigDir = environment.CURSOR_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
  }
  // Same home resolution as `~/.agents` so HOME overrides stay consistent in
  // tests and nonstandard environments.
  return path.join(resolveUserHomeDir(environment), ".cursor");
});

/**
 * Enumerate Cursor/Agent skills from user and project skill roots.
 * Discovery is best-effort: unreadable roots and malformed skill entries are
 * skipped. On name collisions later roots overwrite earlier ones:
 * project > user; within the same scope `.cursor` > `.agents`.
 */
export const discoverCursorSkills = Effect.fn("discoverCursorSkills")(function* (
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<CursorSkillsDiscovery, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const resolvedEnvironment = environment ?? process.env;
  const cursorConfigDirPath = yield* resolveCursorConfigDirPath(resolvedEnvironment, cwd);
  const homeDir = resolveUserHomeDir(resolvedEnvironment);

  const roots: ReadonlyArray<SkillFilesystemRoot> = [
    { directory: path.join(homeDir, ".agents", "skills"), scope: "user" },
    { directory: path.join(cursorConfigDirPath, "skills"), scope: "user" },
    ...(cwd
      ? [
          { directory: path.join(cwd, ".agents", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".cursor", "skills"), scope: "project" as const },
        ]
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
