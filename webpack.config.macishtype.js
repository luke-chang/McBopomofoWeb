const path = require("path");
const TerserPlugin = require("terser-webpack-plugin");

// Two ESM bundles for the macOS MacishType host (JavaScriptCore):
//   index.js (~3KB)         – host adapter, default-exports McBopomofoEngine
//   McBopomofo.js (~4.5MB)  – language facade + KeyHandler + lang model
// The wrapper's `import "./macishtype_facade"` is marked external so it
// emits as `import "./McBopomofo.js"` in output; JSC's ESM module loader
// resolves and parses the second bundle at runtime.
module.exports = {
  entry: {
    index: "./src/macishtype.ts",
    McBopomofo: "./src/macishtype_facade.ts",
  },
  target: "es2020",
  experiments: {
    outputModule: true,
  },
  externalsType: "module",
  externals: {
    "./macishtype_facade": "./McBopomofo.js",
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        include: [path.resolve(__dirname, "src")],
        exclude: [
          path.resolve(__dirname, "src/index.ts"),
          path.resolve(__dirname, "src/chromeos_ime.ts"),
          path.resolve(__dirname, "src/mcp.ts"),
          path.resolve(__dirname, "src/pime.ts"),
          path.resolve(__dirname, "src/pime_keys.ts"),
        ],
        use: {
          loader: "ts-loader",
          // Override CommonJS default from tsconfig.json. ESM lets webpack
          // emit `export default class` directly to JSC; CJS would wrap it
          // in a `{ default: class }` object and break engineClass.construct.
          options: { compilerOptions: { module: "esnext" } },
        },
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  output: {
    filename: "[name].js",
    path: path.resolve(__dirname, "output/macishtype"),
    library: {
      type: "module",
    },
  },
  // Suppress the auto-generated *.LICENSE.txt sidecar; the bundle inlines
  // dependencies whose @license comments would otherwise spill out.
  optimization: {
    minimizer: [new TerserPlugin({ extractComments: false })],
  },
};
