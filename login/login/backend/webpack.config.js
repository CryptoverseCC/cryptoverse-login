const path = require("path");
const webpack = require("webpack");

module.exports = {
  entry: "./src/server.ts",
  target: "node15",

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
