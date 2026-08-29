import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Emit `.next/standalone`: a server.js plus only the modules the app actually
   * imports, traced from the build. The Docker runtime stage copies that instead
   * of node_modules, which is the difference between a ~150 MB image and a
   * ~1.2 GB one -- and on a VPS that also runs the agent, image size is memory
   * that stays available for the work.
   *
   * No effect on `next dev` or `next start` locally.
   */
  output: "standalone",

  /**
   * Trace from this directory, not from the repository root.
   *
   * Next picks the tracing root by walking up for a lockfile, and the root
   * package.json has one -- so by default the standalone build is emitted at
   * `.next/standalone/apps/web/` here and at `.next/standalone/` inside the
   * Docker image, whose build context is this directory alone and has no parent
   * lockfile to find. Same command, two layouts, and the image's COPY silently
   * gets whichever one the context happened to produce.
   *
   * Pinning it makes both emit `.next/standalone/server.js`. Safe because
   * nothing under apps/web imports from outside apps/web.
   */
  outputFileTracingRoot: __dirname,

  /**
   * The dev server blocks cross-origin requests to dev-only assets, and treats
   * only the hostname it was started with as its own -- which is `localhost`.
   *
   * Everything in this project is pinned to 127.0.0.1 (the Supabase site_url,
   * the auth cookie name, the test suites), and browsers treat `localhost` and
   * `127.0.0.1` as different origins. Without this, every /_next asset comes
   * back 403 when the app is opened on 127.0.0.1 and the page renders unstyled
   * and unhydrated.
   *
   * Development only -- the option has no effect on a production build.
   */
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
