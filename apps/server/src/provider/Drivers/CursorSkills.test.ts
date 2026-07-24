import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverCursorSkills } from "./CursorSkills.ts";

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

it.layer(NodeServices.layer)("discoverCursorSkills", (it) => {
  it.effect("discovers user and project skills across Agent and Cursor roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const homeDir = path.join(tempDir, "home");
      const cursorConfigDir = path.join(tempDir, "cursor-config");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(homeDir, ".agents", "skills"),
        "user-agents",
        ["---", "name: user-agents", "description: From user .agents.", "---", "", "# Body"].join(
          "\n",
        ),
      );
      yield* writeSkill(
        path.join(cursorConfigDir, "skills"),
        "user-cursor",
        [
          "---",
          "name: user-cursor",
          "description: From user cursor config.",
          "---",
          "",
          "# Body",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "project-agents",
        [
          "---",
          "name: project-agents",
          "description: From project .agents.",
          "---",
          "",
          "# Body",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".cursor", "skills"),
        "project-cursor",
        [
          "---",
          "name: project-cursor",
          "description: From project .cursor.",
          "---",
          "",
          "# Body",
        ].join("\n"),
      );

      const discovered = yield* discoverCursorSkills(workspace, {
        HOME: homeDir,
        CURSOR_CONFIG_DIR: cursorConfigDir,
      });

      assert.deepEqual(discovered.skills, [
        {
          name: "project-agents",
          path: path.join(workspace, ".agents", "skills", "project-agents", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "From project .agents.",
        },
        {
          name: "project-cursor",
          path: path.join(workspace, ".cursor", "skills", "project-cursor", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "From project .cursor.",
        },
        {
          name: "user-agents",
          path: path.join(homeDir, ".agents", "skills", "user-agents", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "From user .agents.",
        },
        {
          name: "user-cursor",
          path: path.join(cursorConfigDir, "skills", "user-cursor", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "From user cursor config.",
        },
      ]);
      assert.deepEqual(discovered.slashCommands, [
        { name: "project-agents", description: "From project .agents." },
        { name: "project-cursor", description: "From project .cursor." },
        { name: "user-agents", description: "From user .agents." },
        { name: "user-cursor", description: "From user cursor config." },
      ]);
    }),
  );

  it.effect("prefers project over user and .cursor over .agents on name collisions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const homeDir = path.join(tempDir, "home");
      const cursorConfigDir = path.join(tempDir, "cursor-config");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(homeDir, ".agents", "skills"),
        "deploy",
        ["---", "name: deploy", "description: User agents deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(cursorConfigDir, "skills"),
        "deploy",
        ["---", "name: deploy", "description: User cursor deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Project agents deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".cursor", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Project cursor deploy.", "---"].join("\n"),
      );

      const discovered = yield* discoverCursorSkills(workspace, {
        HOME: homeDir,
        CURSOR_CONFIG_DIR: cursorConfigDir,
      });

      assert.equal(discovered.skills.length, 1);
      assert.equal(discovered.skills[0]?.scope, "project");
      assert.equal(discovered.skills[0]?.description, "Project cursor deploy.");
      assert.equal(
        discovered.skills[0]?.path,
        path.join(workspace, ".cursor", "skills", "deploy", "SKILL.md"),
      );
    }),
  );

  it.effect("within user scope prefers cursor config over .agents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const homeDir = path.join(tempDir, "home");
      const cursorConfigDir = path.join(tempDir, "cursor-config");

      yield* writeSkill(
        path.join(homeDir, ".agents", "skills"),
        "shared",
        ["---", "name: shared", "description: Agents wins first.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(cursorConfigDir, "skills"),
        "shared",
        ["---", "name: shared", "description: Cursor overwrites.", "---"].join("\n"),
      );

      const discovered = yield* discoverCursorSkills(undefined, {
        HOME: homeDir,
        CURSOR_CONFIG_DIR: cursorConfigDir,
      });

      assert.equal(discovered.skills.length, 1);
      assert.equal(discovered.skills[0]?.scope, "user");
      assert.equal(discovered.skills[0]?.description, "Cursor overwrites.");
    }),
  );

  it.effect("falls back to the directory name and skips malformed frontmatter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const cursorConfigDir = path.join(tempDir, "cursor-config");
      const skillsDir = path.join(cursorConfigDir, "skills");

      yield* writeSkill(skillsDir, "no-frontmatter", "# Just a heading\n");
      yield* writeSkill(skillsDir, "broken-yaml", "---\nname: [unclosed\n---\n");
      yield* fs.makeDirectory(skillsDir, { recursive: true });
      yield* fs.writeFileString(path.join(skillsDir, "README.md"), "not a skill");

      const discovered = yield* discoverCursorSkills(undefined, {
        HOME: path.join(tempDir, "empty-home"),
        CURSOR_CONFIG_DIR: cursorConfigDir,
      });

      assert.deepEqual(
        discovered.skills.map((skill) => skill.name),
        ["no-frontmatter"],
      );
      assert.equal(discovered.skills[0]?.description, undefined);
      assert.deepEqual(discovered.slashCommands, [{ name: "no-frontmatter" }]);
    }),
  );

  it.effect("omits skills channel when disable-model-invocation is true", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const cursorConfigDir = path.join(tempDir, "cursor-config");
      const skillsDir = path.join(cursorConfigDir, "skills");

      yield* writeSkill(
        skillsDir,
        "slash-only",
        [
          "---",
          "name: slash-only",
          "description: Slash menu only.",
          "disable-model-invocation: true",
          "---",
        ].join("\n"),
      );
      yield* writeSkill(
        skillsDir,
        "both-channels",
        [
          "---",
          "name: both-channels",
          "description: Both menus.",
          "disable-model-invocation: false",
          "---",
        ].join("\n"),
      );
      yield* writeSkill(
        skillsDir,
        "string-true",
        [
          "---",
          "name: string-true",
          "description: String true also excludes skills.",
          'disable-model-invocation: "true"',
          "---",
        ].join("\n"),
      );

      const discovered = yield* discoverCursorSkills(undefined, {
        HOME: path.join(tempDir, "empty-home"),
        CURSOR_CONFIG_DIR: cursorConfigDir,
      });

      assert.deepEqual(
        discovered.skills.map((skill) => skill.name),
        ["both-channels"],
      );
      assert.deepEqual(
        discovered.slashCommands.map((command) => command.name),
        ["both-channels", "slash-only", "string-true"],
      );
      assert.equal(
        discovered.slashCommands.find((command) => command.name === "slash-only")?.description,
        "Slash menu only.",
      );
    }),
  );

  it.effect("honors CURSOR_CONFIG_DIR from the environment", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const environmentConfigDir = path.join(tempDir, "env-config");

      yield* writeSkill(
        path.join(environmentConfigDir, "skills"),
        "env-skill",
        ["---", "name: env-skill", "description: From env config dir.", "---"].join("\n"),
      );

      const discovered = yield* discoverCursorSkills(undefined, {
        HOME: path.join(tempDir, "empty-home"),
        CURSOR_CONFIG_DIR: environmentConfigDir,
      });

      assert.deepEqual(
        discovered.skills.map((skill) => skill.name),
        ["env-skill"],
      );
    }),
  );

  it.effect("resolves a relative CURSOR_CONFIG_DIR against the workspace cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });

      yield* writeSkill(
        path.join(workspace, "relative-config", "skills"),
        "relative-skill",
        ["---", "name: relative-skill", "---"].join("\n"),
      );

      const discovered = yield* discoverCursorSkills(workspace, {
        HOME: path.join(tempDir, "empty-home"),
        CURSOR_CONFIG_DIR: "relative-config",
      });

      assert.deepEqual(
        discovered.skills.map((skill) => skill.name),
        ["relative-skill"],
      );
      assert.equal(discovered.skills[0]?.scope, "user");
    }),
  );

  it.effect("does not scan .claude, .codex, or skills-cursor directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const homeDir = path.join(tempDir, "home");
      const cursorConfigDir = path.join(tempDir, "cursor-config");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "claude-only",
        ["---", "name: claude-only", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".codex", "skills"),
        "codex-only",
        ["---", "name: codex-only", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(cursorConfigDir, "skills-cursor"),
        "builtin-cursor",
        ["---", "name: builtin-cursor", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".cursor", "commands"),
        "legacy-command",
        ["---", "name: legacy-command", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(cursorConfigDir, "skills"),
        "allowed",
        ["---", "name: allowed", "---"].join("\n"),
      );

      const discovered = yield* discoverCursorSkills(workspace, {
        HOME: homeDir,
        CURSOR_CONFIG_DIR: cursorConfigDir,
      });

      assert.deepEqual(
        discovered.skills.map((skill) => skill.name),
        ["allowed"],
      );
    }),
  );

  it.effect("returns empty lists when no skill roots exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });

      const discovered = yield* discoverCursorSkills(path.join(tempDir, "missing-workspace"), {
        HOME: path.join(tempDir, "missing-home"),
        CURSOR_CONFIG_DIR: path.join(tempDir, "missing-cursor-config"),
      });

      assert.deepEqual(discovered, { skills: [], slashCommands: [] });
    }),
  );
});
