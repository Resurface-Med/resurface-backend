/** @type {import('next').NextConfig} */
export default {
  // api.tryresurface.com is not a page for people; keep it out of search so
  // it never competes with tryresurface.com for "Resurface" (2026-11-06).
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] }];
  },
  // The Claude connector's sign-in metadata has to live at a fixed
  // /.well-known address; the route that answers it is an ordinary one.
  async rewrites() {
    return [
      { source: "/.well-known/oauth-protected-resource", destination: "/api/oauth-resource" },
      { source: "/.well-known/oauth-protected-resource/:path*", destination: "/api/oauth-resource" },
    ];
  },
};
