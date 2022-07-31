const { whenProd, paths } = require("@craco/craco");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const path = require("path");
const webpack = require("webpack");

module.exports = {
  webpack: {
    plugins: {
      remove: [...whenProd(() => ["HtmlWebpackPlugin"], [])],
      add: [
        ...whenProd(
          () =>
            [
              new HtmlWebpackPlugin({
                inject: true,
                template: "./public/index.html",
                excludeChunks: ["embed", "final"],
                minify: {
                  removeComments: true,
                  collapseWhitespace: true,
                  removeRedundantAttributes: true,
                  useShortDoctype: true,
                  removeEmptyAttributes: true,
                  removeStyleLinkTypeAttributes: true,
                  keepClosingSlash: true,
                  minifyJS: true,
                  minifyCSS: true,
                  minifyURLs: true,
                },
              }),
              new webpack.ProvidePlugin({
                process: "process/browser",
                Buffer: ["buffer", "Buffer"],
              }),
            ].filter(Boolean),
          []
        ),
      ],
    },
    configure: function (webpackConfig, { env, paths }) {
      webpackConfig.output.filename = (pathData) => {
        console.log(`CHUNK: ${pathData.chunk.name}`);

        if (pathData.chunk.name === "embed") {
          return "static/js/embed.js";
        }
        if (pathData.chunk.name === "final") {
          return "static/js/final.js";
        }
        return webpackConfig.isEnvProduction
          ? "static/js/[name].[contenthash:8].js"
          : "static/js/bundle.[contenthash:8].js";
      };

      webpackConfig.optimization.splitChunks = {
        chunks: (chunk) => {
          // exclude `my-excluded-chunk`
          console.log(`CHUNK NAME: ${chunk.name}`);
          return chunk.name !== "embed" && chunk.name !== "final";
        },
        name: false,
      };
      webpackConfig.optimization.runtimeChunk = false;

      webpackConfig.entry = {
        main: path.resolve(__dirname, "./src/index.tsx"),
        embed: path.resolve(__dirname, "./src/embed/index.ts"),
        final: path.resolve(__dirname, "./src/final/index.ts"),
      };

      webpackConfig.resolve.extensions = [".ts", ".tsx", ".js", ".jsx"];
      webpackConfig.resolve.fallback = {
        crypto: false,
        https: false,
        http: false,
        stream: require.resolve("stream-browserify"),
        buffer: require.resolve("buffer"),
        os: false,
        url: false,
        assert: false,
      };

      return webpackConfig;
    },
  },
};
