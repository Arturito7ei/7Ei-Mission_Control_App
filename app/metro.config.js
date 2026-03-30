const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const monorepoRoot = path.resolve(projectRoot, '..')

const config = getDefaultConfig(projectRoot)

// Monorepo: watch root for shared packages
config.watchFolders = [monorepoRoot]

// Resolve from app workspace first, then root
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
]

// Block root node_modules/react-native from being resolved
// (root has RN 0.84.1 from @clerk → @solana → react-native, conflicts with app's 0.81.5)
config.resolver.blockList = [
  new RegExp(path.resolve(monorepoRoot, 'node_modules', 'react-native') + '/.*'),
]

module.exports = config
