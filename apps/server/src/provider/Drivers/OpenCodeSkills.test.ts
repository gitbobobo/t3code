import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverOpenCodeSkills } from "./OpenCodeSkills.ts";

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

it.layer(NodeServices.layer)("discoverOpenCodeSkills", (it) => {
  it.effect("discovers user and project skills across Agent and OpenCode roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const homeDir = path.join(tempDir, "home");
      const openCodeConfigDir = path.join(tempDir, "opencode-config");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(homeDir, ".agents", "skills"),
        "user-agents",
        ["---", "name: user-agents", "description: From user .agents.", "---", "", "# Body"].join(
          "\n",
        ),
      );
      yield* writeSkill(
        path.join(homeDir, ".config", "opencode", "skills"),
        "user-opencode",
        [
          "---",
          "name: user-opencode",
          "description: From user opencode config.",
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
        path.join(workspace, ".opencode", "skills"),
        "project-opencode",
        [
          "---",
          "name: project-opencode",
          "description: From project .opencode.",
          "---",
          "",
          "# Body",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(openCodeConfigDir, "skills"),
        "env-config",
        ["---", "name: env-config", "description: From OPENCODE_CONFIG_DIR.", "---"].join("\n"),
      );

      const discovered = yield* discoverOpenCodeSkills(workspace, {
        HOME: homeDir,
        OPENCODE_CONFIG_DIR: openCodeConfigDir,
      });

      assert.deepEqual(discovered.skills, [
        {
          name: "env-config",
          path: path.join(openCodeConfigDir, "skills", "env-config", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "From OPENCODE_CONFIG_DIR.",
        },
        {
          name: "project-agents",
          path: path.join(workspace, ".agents", "skills", "project-agents", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "From project .agents.",
        },
        {
          name: "project-opencode",
          path: path.join(workspace, ".opencode", "skills", "project-opencode", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "From project .opencode.",
        },
        {
          name: "user-agents",
          path: path.join(homeDir, ".agents", "skills", "user-agents", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "From user .agents.",
        },
        {
          name: "user-opencode",
          path: path.join(homeDir, ".config", "opencode", "skills", "user-opencode", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "From user opencode config.",
        },
      ]);
      assert.deepEqual(discovered.slashCommands, [
        { name: "env-config", description: "From OPENCODE_CONFIG_DIR." },
        { name: "project-agents", description: "From project .agents." },
        { name: "project-opencode", description: "From project .opencode." },
        { name: "user-agents", description: "From user .agents." },
        { name: "user-opencode", description: "From user opencode config." },
      ]);
    }),
  );

  it.effect("prefers OPENCODE_CONFIG_DIR over project over user on name collisions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const homeDir = path.join(tempDir, "home");
      const openCodeConfigDir = path.join(tempDir, "opencode-config");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(homeDir, ".config", "opencode", "skills"),
        "deploy",
        ["---", "name: deploy", "description: User opencode deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".opencode", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Project opencode deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(openCodeConfigDir, "skills"),
        "deploy",
        ["---", "name: deploy", "description: Config dir deploy.", "---"].join("\n"),
      );

      const discovered = yield* discoverOpenCodeSkills(workspace, {
        HOME: homeDir,
        OPENCODE_CONFIG_DIR: openCodeConfigDir,
      });

      assert.equal(discovered.skills.length, 1);
      assert.equal(discovered.skills[0]?.description, "Config dir deploy.");
      assert.equal(
        discovered.skills[0]?.path,
        path.join(openCodeConfigDir, "skills", "deploy", "SKILL.md"),
      );
    }),
  );

  it.effect("within the same scope prefers .opencode over .agents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "shared",
        ["---", "name: shared", "description: Agents first.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".opencode", "skills"),
        "shared",
        ["---", "name: shared", "description: OpenCode overwrites.", "---"].join("\n"),
      );

      const discovered = yield* discoverOpenCodeSkills(workspace, {
        HOME: path.join(tempDir, "empty-home"),
      });

      assert.equal(discovered.skills.length, 1);
      assert.equal(discovered.skills[0]?.scope, "project");
      assert.equal(discovered.skills[0]?.description, "OpenCode overwrites.");
    }),
  );

  it.effect("falls back to the directory name and skips malformed frontmatter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const skillsDir = path.join(tempDir, "home", ".config", "opencode", "skills");

      yield* writeSkill(skillsDir, "no-frontmatter", "# Just a heading\n");
      yield* writeSkill(skillsDir, "broken-yaml", "---\nname: [unclosed\n---\n");
      yield* fs.makeDirectory(skillsDir, { recursive: true });
      yield* fs.writeFileString(path.join(skillsDir, "README.md"), "not a skill");

      const discovered = yield* discoverOpenCodeSkills(undefined, {
        HOME: path.join(tempDir, "home"),
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
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const skillsDir = path.join(tempDir, "home", ".config", "opencode", "skills");

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

      const discovered = yield* discoverOpenCodeSkills(undefined, {
        HOME: path.join(tempDir, "home"),
      });

      assert.deepEqual(
        discovered.skills.map((skill) => skill.name),
        ["both-channels"],
      );
      assert.deepEqual(
        discovered.slashCommands.map((command) => command.name),
        ["both-channels", "slash-only"],
      );
    }),
  );

  it.effect("resolves a relative OPENCODE_CONFIG_DIR against the workspace cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });

      yield* writeSkill(
        path.join(workspace, "relative-config", "skills"),
        "relative-skill",
        ["---", "name: relative-skill", "---"].join("\n"),
      );

      const discovered = yield* discoverOpenCodeSkills(workspace, {
        HOME: path.join(tempDir, "empty-home"),
        OPENCODE_CONFIG_DIR: "relative-config",
      });

      assert.deepEqual(
        discovered.skills.map((skill) => skill.name),
        ["relative-skill"],
      );
      assert.equal(discovered.skills[0]?.scope, "user");
    }),
  );

  it.effect("does not scan .claude or .codex directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const homeDir = path.join(tempDir, "home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "claude-only",
        ["---", "name: claude-only", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(homeDir, ".claude", "skills"),
        "claude-user-only",
        ["---", "name: claude-user-only", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".codex", "skills"),
        "codex-only",
        ["---", "name: codex-only", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".opencode", "skills"),
        "allowed",
        ["---", "name: allowed", "---"].join("\n"),
      );

      const discovered = yield* discoverOpenCodeSkills(workspace, { HOME: homeDir });

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
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });

      const discovered = yield* discoverOpenCodeSkills(path.join(tempDir, "missing-workspace"), {
        HOME: path.join(tempDir, "missing-home"),
        OPENCODE_CONFIG_DIR: path.join(tempDir, "missing-config"),
      });

      assert.deepEqual(discovered, { skills: [], slashCommands: [] });
    }),
  );
});
