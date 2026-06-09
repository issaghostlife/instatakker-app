const fs = require("fs");

const mod = require("png-to-ico");
const pngToIco = mod.default || mod.pngToIco || mod;

if (typeof pngToIco !== "function") {
  console.log("png-to-ico loaded as:", mod);
  throw new Error("png-to-ico did not load as a function");
}

pngToIco("build/icon.png")
  .then((buf) => {
    fs.writeFileSync("build/icon.ico", buf);
    console.log("✅ Created build/icon.ico");
  })
  .catch((err) => {
    console.error("❌ Failed to create icon:", err);
  });