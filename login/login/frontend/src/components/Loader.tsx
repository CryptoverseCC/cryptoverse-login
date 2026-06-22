import React from "react";

import { StatusView } from "./StatusView";

export interface LoaderProps {}

// The Suspense fallback (used as a bare `<Suspense fallback={<Loader />}`) and
// the app's neutral "warming up" state. It delegates to StatusView's "loading"
// mode so the very first React paint already matches the Vault status surface
// (seal motif + accent), rather than a lone spinner.
export const Loader: React.FC<LoaderProps> = () => (
  <StatusView kind="loading" title="Getting things ready…" />
);

export default Loader;
