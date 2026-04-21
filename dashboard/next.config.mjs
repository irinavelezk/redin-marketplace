/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dashboard reads env from ../.env.local at the root. Next.js picks
  // .env.local from the package dir by default, so we propagate via the
  // `dev`/`start` npm scripts in root package.json.
  transpilePackages: ["@redin/shared", "@redin/tools", "@redin/tono"],
  experimental: {
    // react-pdf ships CJS artifacts; Next 14 handles that but keep esm interop simple.
  },
};
export default nextConfig;
