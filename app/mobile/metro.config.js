// Metro: let the app import the shared TypeScript contract from ../core as `@flux/core`
// (no copy, no build step). watchFolders makes Metro see files outside the project root.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const coreRoot = path.resolve(projectRoot, "../core");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [...(config.watchFolders ?? []), coreRoot];
config.resolver.extraNodeModules = { ...(config.resolver.extraNodeModules ?? {}), "@flux/core": coreRoot };
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

module.exports = config;
