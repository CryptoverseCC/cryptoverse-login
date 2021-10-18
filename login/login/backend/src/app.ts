import express from "express";
import path from "path";
import logger from "morgan";
import cookieParser from "cookie-parser";
import bodyParser from "body-parser";
import * as Sentry from "@sentry/node";
import promBundle from "express-prom-bundle";
import RenderingEngine from "express-handlebars";

import { router as loginRouter } from "./routes/login";
import { router as consentRouter } from "./routes/consent";

const app = express();
const version = process.env["VERSION"]
const sentryDSN = process.env["SENTRY_DSN"]
const metricsMiddleware = promBundle({
  includeMethod: true,
  includePath: true,
  includeStatusCode: true,
  includeUp: true,
  metricsPath: "/---/metrics",
});

Sentry.init({
  dsn: sentryDSN,
  release: version,
});

// Sentry
app.use(Sentry.Handlers.requestHandler() as express.RequestHandler);
app.use(Sentry.Handlers.errorHandler({
  shouldHandleError: (error) => Number(error.status) >= 400,
}) as express.ErrorRequestHandler);

// Metrics
app.use(metricsMiddleware);

// Rendering engine
app.set("views", path.join(__dirname, "views"));
app.engine(".html", RenderingEngine({ extname: '.html' }));
app.set("view engine", ".html");

// Misc
app.use(logger("dev"));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public/")));

// Application Routes
app.use("/login", loginRouter);
app.use("/consent", consentRouter);

export default app;
