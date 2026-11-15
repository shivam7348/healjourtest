/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // A second local server (e.g. a test copy on another port) can use its own build folder.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The server code (server/**) imports its own TypeScript files with ".js" suffixes (Node ESM style).
  webpack: config => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"]
    };
    return config;
  },
  experimental: {
    // Keep the MongoDB driver and Express as normal Node packages instead of bundling them.
    serverComponentsExternalPackages: ["mongodb", "express"]
  }
};

export default nextConfig;
