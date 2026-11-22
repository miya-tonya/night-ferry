// A small site that runs Night Ferry on its own: the reader page, the API behind it,
// and (when a model is configured) the picture pipeline.
//
//   npm install
//   npm start                      → http://localhost:3210
//   npm run seed                   → copy the demo articles into ./data first, if you like
//   npm run write                  → let a model write tonight's article (examples/write-tonight.js)
//
// PORT and HOST choose where it listens. It listens on 127.0.0.1 only by default, because
// there is no login here: anyone who can reach the API can add notes and wishes. To put it
// on a network, set HOST=0.0.0.0 and put your own authentication in front of it.
// The other settings are environment variables too — see server/ferry.js.
"use strict";
const path = require("path");
const express = require("express");
const { createFerry, ROOT } = require("./ferry");

const PORT = Number(process.env.PORT) || 3210;
const HOST = process.env.HOST || "127.0.0.1";

function createApp(ferry) {
  const app = express();
  app.disable("x-powered-by");
  app.use("/api/night-ferry", ferry.router());
  app.use(express.static(path.join(ROOT, "public")));
  return app;
}

module.exports = { createFerry, createApp };

if (require.main === module) {
  const ferry = createFerry();
  ferry.resumeImageJobs();
  createApp(ferry).listen(PORT, HOST, () => {
    console.log("Night Ferry is at http://" + (HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST) + ":" + PORT + "  (data: " + ferry.paths.file + ")");
  });
}
