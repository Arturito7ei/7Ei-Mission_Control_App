const { expoRouterBabelPlugin } = require('babel-preset-expo/build/expo-router-plugin')

module.exports = function (api) {
  api.cache(true)
  return {
    presets: ['babel-preset-expo'],
    overrides: [
      {
        // Force expo-router env var inlining for _ctx files in node_modules.
        // In a monorepo, babel-preset-expo skips process.env replacement for node_modules,
        // but expo-router's _ctx files need process.env.EXPO_ROUTER_APP_ROOT resolved
        // to a static string for Metro's require.context() to work.
        test: /node_modules[\\/]expo-router[\\/]_ctx/,
        plugins: [expoRouterBabelPlugin],
      },
    ],
  }
}
