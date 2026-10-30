// Static production bundle for browser contract tests. No production data or Docker.
const express = require("express");
const app = express();
app.use(express.static(require("path").join(__dirname, "../../public/ui")));
app.listen(18192, "127.0.0.1");
