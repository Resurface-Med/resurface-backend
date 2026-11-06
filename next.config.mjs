/** @type {import('next').NextConfig} */
export default {
  // The Claude connector's sign-in metadata has to live at a fixed
  // /.well-known address; the route that answers it is an ordinary one.
  async rewrites() {
    return [
      { source: "/.well-known/oauth-protected-resource", destination: "/api/oauth-resource" },
      { source: "/.well-known/oauth-protected-resource/:path*", destination: "/api/oauth-resource" },
    ];
  },
};
