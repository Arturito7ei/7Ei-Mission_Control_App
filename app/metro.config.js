const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const monorepoRoot = path.resolve(projectRoot, '..')

const config = getDefaultConfig(projectRoot)

// Monorepo support: watch all workspace folders
config.watchFolders = [monorepoRoot]

// Resolve modules from both the app workspace and monorepo root
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
]

// Ensure Metro knows the project root is the app workspace (not monorepo root)
// This is critical for expo-router to correctly resolve EXPO_ROUTER_APP_ROOT
config.projectRoot = projectRoot

module.exports = config
