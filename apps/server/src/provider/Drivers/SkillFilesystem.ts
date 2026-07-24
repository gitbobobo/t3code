/**
 * SkillFilesystem — shared filesystem discovery for Agent Skills (`SKILL.md`).
 *
 * Cursor and Claude both load skills as one directory per skill with YAML
 * frontmatter. This module owns frontmatter parsing and one-level root
 * scanning; provider wrappers only resolve their own roots and project the
 * discovered entries into snapshot fields.
 *
 * @module provider/Drivers/SkillFilesystem
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export type SkillMdFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | {
      readonly kind: "parsed";
      readonly name?: string;
      readonly description?: string;
      readonly disableModelInvocation: boolean;
    };

export type SkillFilesystemRoot = {
  readonly directory: string;
  readonly scope: "user" | "project";
};

export type DiscoveredFilesystemSkill = {
  readonly name: string;
  readonly description?: string;
  readonly path: string;
  readonly scope: "user" | "project";
  readonly disableModelInvocation: boolean;
};

function isDisableModelInvocation(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * Parse YAML frontmatter from a `SKILL.md` body.
 * Returns `missing` when no frontmatter fence is present, `malformed` when the
 * YAML is invalid or not a mapping, and `parsed` with optional name/description
 * plus `disable-model-invocation` (Cursor uses this; Claude ignores it).
 */
export function parseSkillMdFrontmatter(contents: string): SkillMdFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    disableModelInvocation: isDisableModelInvocation(record["disable-model-invocation"]),
  };
}

/**
 * Scan one-level `skills/<dir>/SKILL.md` roots. Discovery is best-effort:
 * unreadable roots and malformed skill entries are skipped. On name collisions
 * later roots overwrite earlier ones. Results are sorted by name.
 */
export const discoverSkillsFromRoots = Effect.fn("discoverSkillsFromRoots")(function* (
  roots: ReadonlyArray<SkillFilesystemRoot>,
): Effect.fn.Return<
  ReadonlyArray<DiscoveredFilesystemSkill>,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const skillsByName = new Map<string, DiscoveredFilesystemSkill>();
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      const skillPath = path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseSkillMdFrontmatter(contents);
      // Malformed frontmatter means the skill won't load in the provider CLI
      // either — skip it rather than surfacing a broken entry under its
      // directory name.
      if (frontmatter.kind === "malformed") {
        continue;
      }

      const name = (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? entry.trim();
      if (!name) {
        continue;
      }

      skillsByName.set(name, {
        name,
        path: skillPath,
        scope: root.scope,
        disableModelInvocation:
          frontmatter.kind === "parsed" ? frontmatter.disableModelInvocation : false,
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
