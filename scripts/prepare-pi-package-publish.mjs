import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const rootPackagePath = new URL("../package.json", import.meta.url);
const piPackagePath = new URL("../pi-package/package.json", import.meta.url);
const clientPackagePath = new URL("../packages/client/package.json", import.meta.url);
const clientDistPath = new URL("../packages/client/dist", import.meta.url);
const clientReadmePath = new URL("../packages/client/README.md", import.meta.url);
const rootLicensePath = new URL("../LICENSE", import.meta.url);
const piPackageReadmePath = new URL("../pi-package/README.md", import.meta.url);
const piPackageExtensionsPath = new URL("../pi-package/extensions", import.meta.url);
const piPackageSkillsPath = new URL("../pi-package/skills", import.meta.url);
const stageDirPath = new URL("../tmp/pi-package-publish/", import.meta.url);
const stagedPackageJsonPath = new URL("package.json", stageDirPath);
const stagedLicensePath = new URL("LICENSE", stageDirPath);
const stagedReadmePath = new URL("README.md", stageDirPath);
const stagedExtensionsPath = new URL("extensions", stageDirPath);
const stagedSkillsPath = new URL("skills", stageDirPath);
const stagedBundledClientDir = new URL("node_modules/@eforge-build/client/", stageDirPath);
const stagedBundledClientDist = new URL("dist", stagedBundledClientDir);
const stagedBundledClientPackageJson = new URL("package.json", stagedBundledClientDir);
const stagedBundledClientReadme = new URL("README.md", stagedBundledClientDir);

const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
const piPackage = JSON.parse(readFileSync(piPackagePath, "utf8"));

// Map workspace package names to their actual versions for dependency rewriting
const workspacePackageVersions = {
  "@eforge-build/client": JSON.parse(readFileSync(clientPackagePath, "utf8")).version,
};

piPackage.version = rootPackage.version;
piPackage.homepage = rootPackage.homepage;
piPackage.repository = rootPackage.repository;
piPackage.publishConfig = { access: "public" };
// `node_modules/` is listed so npm pack honors `bundledDependencies` and ships
// the built `@eforge-build/client` tree inside the tarball. Pi resolves the
// import via standard Node module resolution from the extension's location.
piPackage.files = ["extensions/", "skills/", "node_modules/", "README.md", "LICENSE"];

// Rewrite workspace:* dependencies to concrete versions
if (piPackage.dependencies) {
  for (const [dep, ver] of Object.entries(piPackage.dependencies)) {
    if (typeof ver === 'string' && ver.startsWith('workspace:')) {
      const resolvedVersion = workspacePackageVersions[dep];
      if (!resolvedVersion) {
        throw new Error(`No version mapping for workspace dependency "${dep}". Add it to workspacePackageVersions.`);
      }
      piPackage.dependencies[dep] = resolvedVersion;
    }
  }
}

piPackage.peerDependencies = {
  ...piPackage.peerDependencies,
  "@mariozechner/pi-tui": "*",
};
piPackage.peerDependenciesMeta = {
  ...piPackage.peerDependenciesMeta,
  "@mariozechner/pi-tui": { optional: false },
};

rmSync(stageDirPath, { recursive: true, force: true });
mkdirSync(stageDirPath, { recursive: true });
cpSync(rootLicensePath, stagedLicensePath);
cpSync(piPackageReadmePath, stagedReadmePath);
cpSync(piPackageExtensionsPath, stagedExtensionsPath, { recursive: true });
cpSync(piPackageSkillsPath, stagedSkillsPath, { recursive: true });

// Stage the built @eforge-build/client alongside pi-package so that
// `bundledDependencies` in the published package.json ships a self-contained
// `node_modules/@eforge-build/client/` tree inside the tarball. The Pi
// extension loads its raw `.ts` source via jiti; when jiti resolves
// `@eforge-build/client`, Node's module resolver walks up from the extension
// file and finds the bundled copy without the consumer ever installing it.
if (!existsSync(clientDistPath)) {
  throw new Error(
    `@eforge-build/client has not been built. Run \`pnpm --filter @eforge-build/client build\` before preparing the Pi package.`,
  );
}
mkdirSync(stagedBundledClientDir, { recursive: true });
cpSync(clientDistPath, stagedBundledClientDist, { recursive: true });
cpSync(clientPackagePath, stagedBundledClientPackageJson);
if (existsSync(clientReadmePath)) {
  cpSync(clientReadmePath, stagedBundledClientReadme);
}

writeFileSync(stagedPackageJsonPath, `${JSON.stringify(piPackage, null, 2)}\n`);

console.log(`Prepared ${stageDirPath.pathname} for npm publish (version ${rootPackage.version}).`);
