const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "..");
const source = path.join(repositoryRoot, ".claude", "skills");
const target = path.join(repositoryRoot, ".agents", "skills");

if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
  throw new Error(`Skill source directory not found: ${source}`);
}

if (fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false })) {
  const targetStats = fs.lstatSync(target);

  if (targetStats.isSymbolicLink()) {
    const linkedPath = path.resolve(path.dirname(target), fs.readlinkSync(target));
    if (linkedPath === source) {
      console.log("Agent skills link is already configured.");
      process.exit(0);
    }
    throw new Error(`Refusing to replace existing link: ${target}`);
  }

  if (!targetStats.isDirectory()) {
    throw new Error(`Refusing to replace existing file: ${target}`);
  }

  if (fs.readdirSync(target).length > 0) {
    throw new Error(`Refusing to replace non-empty directory: ${target}`);
  }

  fs.rmdirSync(target);
}

fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
console.log(`Linked .agents/skills to .claude/skills.`);
