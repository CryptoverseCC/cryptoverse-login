const path = require("path");
const webpack = require("webpack");

module.exports = {
  entry: "./src/server.ts",
  target: "node18",
  mode: "production",

  devtool: "inline-source-map",
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".js"],
    mainFields: ["main", "module"],
  },
  output: {
    filename: "server.js",
    path: path.resolve(__dirname, "build"),
  },
  plugins: [
    new webpack.ProvidePlugin({
      window: "global/window",
    }),
  ],
};
